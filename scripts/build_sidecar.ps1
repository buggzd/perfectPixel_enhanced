# Build the Perfect Pixel Python backend as a PyInstaller **onedir** bundle and
# place it where Tauri expects its sidecar (named with the Rust target triple).
#
#   frontend\src-tauri\binaries\perfect-pixel-api-<triple>\
#       perfect-pixel-api.exe        (executable)
#       ... (libs, datas)
#
# onedir (vs onefile) avoids the multi-second temp-dir extraction on every
# launch. Tauri bundles the whole directory via `resources`.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir
$Venv      = Join-Path $RepoRoot ".venv"
$VenvPy    = Join-Path $Venv "Scripts\python.exe"

if (Test-Path $VenvPy) {
    $Py = $VenvPy
} else {
    Write-Host ">> .venv not found; creating one with python"
    python -m venv $Venv
    $Py = $VenvPy
}

Write-Host ">> Installing dependencies + pyinstaller"
& $Py -m pip install --upgrade pip | Out-Null
& $Py -m pip install -r (Join-Path $RepoRoot "requirements.txt") pyinstaller | Out-Null

Write-Host ">> Building sidecar (onedir)"
Push-Location $RepoRoot
& $Py -m PyInstaller scripts\perfect_pixel_api.spec `
    --noconfirm `
    --distpath build\sidecar `
    --workpath build\pyi `
    --clean
Pop-Location

# PyInstaller onedir emits build\sidecar\perfect-pixel-api\perfect-pixel-api.exe
$SrcDir = Join-Path $RepoRoot "build\sidecar\perfect-pixel-api"
$SrcExe = Join-Path $SrcDir "perfect-pixel-api.exe"
if (-not (Test-Path $SrcExe)) {
    throw "Expected onedir bundle at $SrcExe not found"
}

# Resolve the Rust host target triple (e.g. x86_64-pc-windows-msvc).
$triple = (rustc -vV | Select-String "^host:").ToString().Split(":")[1].Trim()
if ([string]::IsNullOrWhiteSpace($triple)) {
    throw "Could not determine rustc host triple. Is rustc installed?"
}

$OutDir = Join-Path $RepoRoot "frontend\src-tauri\binaries"
$Dest   = Join-Path $OutDir "perfect-pixel-api-$triple"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
Copy-Item -Path $SrcDir -Destination $Dest -Recurse

Write-Host ">> Sidecar ready: $Dest"
