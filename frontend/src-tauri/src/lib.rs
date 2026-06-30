// Perfect Pixel — Tauri shell.
//
// The Tauri main process owns the lifecycle of a Python FastAPI backend:
// it picks a free port, spawns the backend (the repo's `.venv` python in dev,
// the bundled PyInstaller sidecar binary in release), waits for it to become
// healthy, exposes its URL to the frontend, and tears it down on exit.
//
// The frontend never knows the port ahead of time — it asks via the
// `backend_url` / `backend_status` commands during boot.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Shared backend lifecycle state.
#[derive(Default)]
struct BackendState {
    url: Mutex<Option<String>>,
    ready: Mutex<bool>,
    error: Mutex<Option<String>>,
    logs_dir: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
}

impl BackendState {
    fn kill_child(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Grab an ephemeral free port on the loopback interface.
fn pick_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind a free port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

/// Minimal HTTP health probe — avoids pulling in an HTTP client dependency.
fn probe_health(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    let Ok(addr) = addr.parse() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    buf.contains("\"status\":\"ok\"")
}

/// Resolve the python interpreter for dev mode: repo `.venv` if present, else
/// the system `python3`.
fn dev_python(repo_root: &Path) -> PathBuf {
    let venv_python = repo_root
        .join(".venv")
        .join(if cfg!(windows) { "Scripts" } else { "bin" })
        .join(if cfg!(windows) { "python.exe" } else { "python" });
    if venv_python.exists() {
        venv_python
    } else {
        PathBuf::from("python3")
    }
}

/// Build the command that launches the backend, plus the jobs/logs dirs it
/// should use. In dev we run `python -m api.run` from the repo root; in
/// release we run the bundled sidecar binary and use per-user data dirs.
fn build_backend_command(
    app: &tauri::App,
) -> Result<(Command, PathBuf, PathBuf), Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = .../frontend/src-tauri at compile time.
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest
            .parent()
            .and_then(|p| p.parent())
            .ok_or("could not resolve repo root")?
            .to_path_buf();
        let jobs_dir = repo_root.join("jobs");
        let logs_dir = repo_root.join("logs");
        let python = dev_python(&repo_root);
        let mut cmd = Command::new(python);
        cmd.current_dir(&repo_root);
        cmd.args(["-m", "api.run"]);
        Ok((cmd, jobs_dir, logs_dir))
    } else {
        // The sidecar ships as an onedir bundle under `bundle.resources`
        // (map: "binaries/perfect-pixel-api" -> "binaries/"). Tauri copies the
        // source dir's CONTENTS into Resources/binaries/, so the executable and
        // its sibling `_internal/` land at:
        //   <resource_dir>/binaries/perfect-pixel-api[.exe]
        //   <resource_dir>/binaries/_internal/
        // (PyInstaller onedir only needs the exe + _internal to be siblings.)
        let resource_dir = app.path().resource_dir()?;
        let exe_name = if cfg!(windows) {
            "perfect-pixel-api.exe"
        } else {
            "perfect-pixel-api"
        };
        let sidecar = resource_dir.join("binaries").join(exe_name);
        if !sidecar.exists() {
            return Err(format!(
                "sidecar executable not found at {}",
                sidecar.display()
            )
            .into());
        }
        let data_dir = app.path().app_local_data_dir()?;
        let jobs_dir = data_dir.join("jobs");
        let logs_dir = data_dir.join("logs");
        let cmd = Command::new(sidecar);
        Ok((cmd, jobs_dir, logs_dir))
    }
}

/// Spawn the backend and start a background health-poll thread that flips
/// `ready` (or records an `error`) once the probe resolves.
fn spawn_backend(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let port = pick_free_port();
    let (mut cmd, jobs_dir, logs_dir) = build_backend_command(app)?;

    fs::create_dir_all(&jobs_dir)?;
    fs::create_dir_all(&logs_dir)?;

    let url = format!("http://127.0.0.1:{}", port);
    cmd.env("PERFECT_PIXEL_HOST", "127.0.0.1");
    cmd.env("PERFECT_PIXEL_PORT", port.to_string());
    cmd.env("PERFECT_PIXEL_JOBS_DIR", &jobs_dir);

    // Redirect backend stdout/stderr to a log file for debugging.
    let log_path = logs_dir.join("backend.log");
    let log_file = fs::File::create(&log_path)?;
    let err_file = log_file.try_clone()?;
    cmd.stdout(Stdio::from(log_file));
    cmd.stderr(Stdio::from(err_file));

    // On Windows, spawn the backend with no console window. Without this a
    // PyInstaller console sidecar pops a visible `cmd.exe` that the user can
    // close (killing the backend). CREATE_NO_WINDOW hides it entirely; the
    // process is also detached from any parent console so it survives.
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd.spawn()?;

    let state: tauri::State<BackendState> = app.state();
    *state.url.lock().unwrap() = Some(url.clone());
    *state.logs_dir.lock().unwrap() = Some(logs_dir.to_string_lossy().into_owned());
    *state.child.lock().unwrap() = Some(child);

    // Poll /api/health off the main thread; surface readiness to the frontend.
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        // Give the interpreter a moment to import cv2/uvicorn before probing.
        for _ in 0..300 {
            // 300 * 100ms = 30s budget
            if probe_health(port) {
                *handle.state::<BackendState>().ready.lock().unwrap() = true;
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        *handle.state::<BackendState>().error.lock().unwrap() =
            Some("Backend did not become healthy within 30s".into());
    });

    Ok(())
}

// --- Tauri commands --------------------------------------------------------

#[derive(serde::Serialize)]
struct BackendStatus {
    ready: bool,
    url: String,
    error: Option<String>,
}

#[tauri::command]
fn backend_url(state: tauri::State<BackendState>) -> String {
    state.url.lock().unwrap().clone().unwrap_or_default()
}

#[tauri::command]
fn backend_status(state: tauri::State<BackendState>) -> BackendStatus {
    BackendStatus {
        ready: *state.ready.lock().unwrap(),
        url: state.url.lock().unwrap().clone().unwrap_or_default(),
        error: state.error.lock().unwrap().clone(),
    }
}

#[tauri::command]
fn open_logs_dir(state: tauri::State<BackendState>) -> Result<(), String> {
    let dir = state
        .logs_dir
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "logs directory is not available".to_string())?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(BackendState::default())
        .setup(|app| {
            // A backend spawn failure must NOT bubble out of setup: doing so
            // makes Tauri panic inside the Obj-C `applicationDidFinishLaunching`
            // callback, which can't unwind across the FFI boundary and aborts
            // the whole app. Record the error in shared state (the frontend
            // surfaces it) and keep the app alive.
            if let Err(e) = spawn_backend(app) {
                let state: tauri::State<BackendState> = app.state();
                *state.error.lock().unwrap() = Some(format!("{e}"));
                // Seed a logs dir hint so the "open logs" button works even
                // though we never got far enough to set it.
                if state.logs_dir.lock().unwrap().is_none() {
                    if let Ok(data_dir) = app.path().app_local_data_dir() {
                        *state.logs_dir.lock().unwrap() =
                            Some(data_dir.join("logs").to_string_lossy().into_owned());
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_url,
            backend_status,
            open_logs_dir
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<BackendState>() {
                state.kill_child();
            }
        }
    });
}
