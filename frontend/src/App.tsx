import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  checkHealth,
  createJob,
  getJobStatus,
  getJobFrames,
  getFrameUrl,
  deleteJob,
  getBaseUrl,
  setBaseUrl,
  JobOptions,
  JobStatusResponse,
  FrameInfo,
} from "./api";
import { 
  Play, 
  Pause, 
  UploadCloud, 
  Video, 
  AlertTriangle, 
  CheckCircle2, 
  Trash2, 
  Activity, 
  Sparkles, 
  RefreshCw, 
  ArrowLeft, 
  Download
} from "lucide-react";
import "./App.css";

function App() {
  // Connection State
  const [isApiConnected, setIsApiConnected] = useState<boolean | null>(null);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);

  // Boot state: the Tauri shell spawns the Python backend asynchronously.
  // We wait for it to report ready (and learn its port) before talking to it.
  const [bootState, setBootState] = useState<"loading" | "ready" | "error">(
    "__TAURI_INTERNALS__" in window ? "loading" : "ready"
  );

  // Configuration State
  const [sampleMethod, setSampleMethod] = useState<"majority" | "center" | "median">("majority");
  const [gridSizeW, setGridSizeW] = useState<string>("");
  const [gridSizeH, setGridSizeH] = useState<string>("");
  const [refineIntensity, setRefineIntensity] = useState<number>(0.25);
  const [fixSquare, setFixSquare] = useState<boolean>(true);
  const [minSize, setMinSize] = useState<number>(4.0);
  const [peakWidth, setPeakWidth] = useState<number>(6);
  const [outputScale, setOutputScale] = useState<number>(4); // Default to 4x scaling
  const [everyNFrames, setEveryNFrames] = useState<number>(1);

  // Drag and drop states
  const [file, setFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Processing states
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatusResponse | null>(null);

  // Playback / Frame list states
  const [frames, setFrames] = useState<FrameInfo[]>([]);
  const [currentFrameIndex, setCurrentFrameIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackFps, setPlaybackFps] = useState<number>(15);
  const [loopPlayback] = useState<boolean>(true);
  
  // App error states
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Interval references
  const playIntervalRef = useRef<number | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  // 0. Boot: ask the Tauri shell for the backend URL once the sidecar is ready.
  //    In a plain browser (no Tauri), skip and fall back to the default URL.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setBootState("ready");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        for (;;) {
          const st = await invoke<{ ready: boolean; url: string; error: string | null }>(
            "backend_status"
          );
          if (cancelled) return;
          if (st.error) {
            setBootState("error");
            return;
          }
          if (st.ready && st.url) {
            setBaseUrl(st.url);
            setBootState("ready");
            return;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch (e) {
        if (!cancelled) setBootState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 1. Health check — only once the backend URL is known; then poll every 3s.
  const verifyBackendHealth = async () => {
    setIsCheckingConnection(true);
    const healthy = await checkHealth();
    setIsApiConnected(healthy);
    setIsCheckingConnection(false);
  };

  useEffect(() => {
    if (bootState !== "ready") return;
    verifyBackendHealth();
    const interval = window.setInterval(async () => {
      const healthy = await checkHealth();
      setIsApiConnected(healthy);
    }, 3000);
    return () => clearInterval(interval);
  }, [bootState]);

  // 2. Playback control timer
  useEffect(() => {
    if (isPlaying && frames.length > 0) {
      playIntervalRef.current = window.setInterval(() => {
        setCurrentFrameIndex((prevIndex) => {
          if (prevIndex >= frames.length - 1) {
            if (loopPlayback) {
              return 0;
            } else {
              setIsPlaying(false);
              return prevIndex;
            }
          }
          return prevIndex + 1;
        });
      }, 1000 / playbackFps);
    } else {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    }

    return () => {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
      }
    };
  }, [isPlaying, frames, playbackFps, loopPlayback]);

  // 3. Status Poll effect
  useEffect(() => {
    if (currentJobId) {
      pollIntervalRef.current = window.setInterval(async () => {
        try {
          const status = await getJobStatus(currentJobId);
          setJobStatus(status);

          // Update frames list dynamically during execution
          if (status.output_frames.length > 0) {
            // Keep frames list updated
            const mappedFrames: FrameInfo[] = status.output_frames.map((name) => {
              try {
                const idx = parseInt(name.split("_")[1].split(".")[0]);
                return { name, index: idx };
              } catch (e) {
                return { name, index: -1 };
              }
            });
            // Sort by index ascending
            mappedFrames.sort((a, b) => a.index - b.index);
            setFrames(mappedFrames);
          }

          if (status.status === "done") {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            // Fetch complete final list just to be sure
            const finalFrames = await getJobFrames(currentJobId);
            const sortedFrames = [...finalFrames.frames].sort((a, b) => a.index - b.index);
            setFrames(sortedFrames);
            setCurrentFrameIndex(0);
          } else if (status.status === "error") {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setErrorMsg(status.error || "An error occurred during video processing.");
          }
        } catch (e: any) {
          console.error("Polling error: ", e);
        }
      }, 400);
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [currentJobId]);

  // Drag and drop handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      // Basic check for video file
      if (droppedFile.type.startsWith("video/") || droppedFile.name.endsWith(".mp4") || droppedFile.name.endsWith(".mov") || droppedFile.name.endsWith(".avi") || droppedFile.name.endsWith(".webm")) {
        setFile(droppedFile);
        setErrorMsg(null);
      } else {
        setErrorMsg("Invalid file format. Please drop a valid video file.");
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setErrorMsg(null);
    }
  };

  const selectFileManual = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Submit job
  const handleStartProcessing = async () => {
    if (!file) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    setFrames([]);
    setCurrentFrameIndex(0);

    const options: JobOptions = {
      sample_method: sampleMethod,
      grid_size_w: gridSizeW ? parseInt(gridSizeW, 10) : null,
      grid_size_h: gridSizeH ? parseInt(gridSizeH, 10) : null,
      refine_intensity: refineIntensity,
      fix_square: fixSquare,
      min_size: minSize,
      peak_width: peakWidth,
      output_scale: outputScale,
      every_n_frames: everyNFrames
    };

    try {
      const response = await createJob(file, options);
      setCurrentJobId(response.job_id);
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to initiate video process.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Cancel job
  const handleCancelJob = async () => {
    if (!currentJobId) return;
    try {
      await deleteJob(currentJobId);
    } catch (e) {
      console.error("Cleanup error:", e);
    } finally {
      // Clean states
      setCurrentJobId(null);
      setJobStatus(null);
      setFrames([]);
      setCurrentFrameIndex(0);
      setIsPlaying(false);
      setErrorMsg(null);
    }
  };

  // Go back to config
  const handleGoBack = () => {
    if (currentJobId) {
      handleCancelJob();
    } else {
      setFile(null);
      setErrorMsg(null);
    }
  };

  // Helper size converter
  const formatBytes = (bytes: number, decimals = 2) => {
    if (!bytes) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  };

  // Boot screen: shown while the Tauri shell is starting the Python backend,
  // or if it failed to come up.
  if (bootState !== "ready") {
    const isError = bootState === "error";
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: 20,
          background: "var(--bg, #0f1115)",
          color: "var(--text, #e6e6e6)",
          fontFamily: "inherit",
        }}
      >
        <Sparkles size={36} />
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {isError ? "Engine failed to start" : "Initializing engine…"}
        </div>
        <div style={{ fontSize: 13, opacity: 0.6, maxWidth: 380, textAlign: "center" }}>
          {isError
            ? "The pixel-processing backend could not be launched. Check the logs for details."
            : "Starting the Perfect Pixel backend. This only takes a moment."}
        </div>
        {!isError && (
          <div
            style={{
              width: 28,
              height: 28,
              border: "3px solid rgba(255,255,255,0.15)",
              borderTopColor: "#fff",
              borderRadius: "50%",
              animation: "pp-spin 0.8s linear infinite",
            }}
          />
        )}
        {isError && (
          <button
            onClick={() => invoke("open_logs_dir").catch(() => {})}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <AlertTriangle size={16} />
            Open Logs Directory
          </button>
        )}
        <style>{`@keyframes pp-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Render components
  return (
    <div className="app-container">
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo-area">
            <div className="logo-icon">
              <Sparkles size={18} />
            </div>
            <span className="logo-text">Perfect Pixel</span>
            <span className="logo-version">v1.1</span>
          </div>
          <div className="connection-status">
            <div className={`status-dot ${isApiConnected ? "connected" : "disconnected"}`} />
            <span>
              {isApiConnected === null 
                ? "Checking server..." 
                : isApiConnected 
                  ? "Backend Connected" 
                  : "Backend Offline"}
            </span>
          </div>
        </div>

        {/* Configurations Form */}
        <div className="settings-form">
          <div className="settings-section-title">Core Algorithm</div>
          
          <div className="form-group">
            <label>
              Sample Method
              <span className="label-hint">sample_method</span>
            </label>
            <select 
              value={sampleMethod} 
              onChange={(e) => setSampleMethod(e.target.value as any)}
              disabled={!!currentJobId}
            >
              <option value="majority">Majority Color (Best)</option>
              <option value="center">Center Sampling</option>
              <option value="median">Median Color</option>
            </select>
          </div>

          <div className="form-group">
            <label>
              Grid Dimensions (W & H)
              <span className="label-hint">grid_size</span>
            </label>
            <div className="form-group-row">
              <input 
                type="number" 
                placeholder="Auto Width" 
                value={gridSizeW} 
                onChange={(e) => setGridSizeW(e.target.value)}
                disabled={!!currentJobId}
                min="1"
              />
              <input 
                type="number" 
                placeholder="Auto Height" 
                value={gridSizeH} 
                onChange={(e) => setGridSizeH(e.target.value)}
                disabled={!!currentJobId}
                min="1"
              />
            </div>
          </div>

          <div className="form-group">
            <label>
              Refine Intensity: <span className="slider-val">{refineIntensity.toFixed(2)}</span>
            </label>
            <div className="slider-container">
              <input 
                type="range" 
                min="0.0" 
                max="0.5" 
                step="0.01" 
                value={refineIntensity} 
                onChange={(e) => setRefineIntensity(parseFloat(e.target.value))}
                disabled={!!currentJobId}
              />
            </div>
          </div>

          <div className="form-group toggle-group" onClick={() => !currentJobId && setFixSquare(!fixSquare)}>
            <label style={{ cursor: "pointer" }}>Force Square Alignment</label>
            <label className="toggle-switch">
              <input 
                type="checkbox" 
                checked={fixSquare} 
                onChange={() => {}} 
                disabled={!!currentJobId} 
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="settings-section-title">Video & Sizing</div>

          <div className="form-group">
            <label>
              Output Upscale Factor: <span className="slider-val">{outputScale}x</span>
            </label>
            <div className="slider-container">
              <input 
                type="range" 
                min="1" 
                max="16" 
                step="1" 
                value={outputScale} 
                onChange={(e) => setOutputScale(parseInt(e.target.value, 10))}
                disabled={!!currentJobId}
              />
            </div>
          </div>

          <div className="form-group-row">
            <div className="form-group">
              <label>Min Pixel Size</label>
              <input 
                type="number" 
                value={minSize} 
                onChange={(e) => setMinSize(parseFloat(e.target.value))}
                disabled={!!currentJobId}
                min="1" 
                step="0.5"
              />
            </div>
            <div className="form-group">
              <label>Peak Width</label>
              <input 
                type="number" 
                value={peakWidth} 
                onChange={(e) => setPeakWidth(parseInt(e.target.value, 10))}
                disabled={!!currentJobId}
                min="1"
              />
            </div>
          </div>

          <div className="form-group">
            <label>
              Frame Sampling Step
              <span className="label-hint">every_n_frames</span>
            </label>
            <input 
              type="number" 
              value={everyNFrames} 
              onChange={(e) => setEveryNFrames(parseInt(e.target.value, 10))}
              disabled={!!currentJobId}
              min="1"
            />
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="version-note">Tauri Sidecar Integration</div>
        </div>
      </aside>

      {/* MAIN PANEL */}
      <main className="main-panel">
        {/* Offline Alert Banner */}
        {isApiConnected === false && (
          <div className="alert-banner">
            <AlertTriangle size={18} />
            <div>
              <strong>FastAPI backend is offline.</strong> To run, activate the venv and start the server: <code>python -m api.run</code>
            </div>
            <button className="alert-banner-btn" onClick={verifyBackendHealth}>
              {isCheckingConnection ? "Checking..." : "Reconnect"}
            </button>
          </div>
        )}

        <div className="workspace">
          {errorMsg && (
            <div className="alert-banner" style={{ background: "rgba(255, 84, 112, 0.15)", borderColor: "rgba(255, 84, 112, 0.2)", color: "#ff8a9e", borderRadius: "12px", width: "100%", maxWidth: "680px", marginBottom: "20px" }}>
              <AlertTriangle size={18} />
              <div><strong>Error:</strong> {errorMsg}</div>
              <button className="file-remove-btn" style={{ marginLeft: "auto" }} onClick={() => setErrorMsg(null)}>&times;</button>
            </div>
          )}

          {/* STATE 1: UPLOAD / DRAG AND DROP */}
          {!file && !currentJobId && (
            <div 
              className={`dropzone ${isDragActive ? "drag-active" : ""}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={selectFileManual}
            >
              <input 
                ref={fileInputRef}
                type="file" 
                style={{ display: "none" }} 
                accept="video/*"
                onChange={handleFileChange}
              />
              <div className="upload-icon-container">
                <UploadCloud size={36} />
              </div>
              <h3 className="dropzone-title">Upload Video File</h3>
              <p className="dropzone-desc">Drag & drop your pixel style video here (mp4, mov, avi, webm)</p>
              <button className="browse-btn">Browse Files</button>
            </div>
          )}

          {/* STATE 2: FILE SELECTED, CONFIRM TO SUBMIT */}
          {file && !currentJobId && (
            <div className="selected-file-card">
              <div className="file-info-header">
                <div className="file-icon">
                  <Video size={24} />
                </div>
                <div className="file-details">
                  <div className="file-name">{file.name}</div>
                  <div className="file-meta">
                    {formatBytes(file.size)} | {file.type || "video/mp4"}
                  </div>
                </div>
                <button className="file-remove-btn" onClick={() => setFile(null)}>
                  <Trash2 size={16} />
                </button>
              </div>

              <button 
                className="submit-btn" 
                onClick={handleStartProcessing} 
                disabled={isSubmitting || !isApiConnected}
              >
                {isSubmitting ? (
                  <>
                    <span className="spinner" />
                    Initializing Job...
                  </>
                ) : (
                  <>
                    <Sparkles size={18} />
                    Process to Pixel Art
                  </>
                )}
              </button>
            </div>
          )}

          {/* STATE 3: PROCESSING PROGRESS TRACKER */}
          {currentJobId && jobStatus && jobStatus.status !== "done" && jobStatus.status !== "error" && (
            <div className="process-card">
              <div className="process-header">
                <div className="process-title-area">
                  <h3 className="process-title">Aligning Grid & Color sampling</h3>
                  <span className="process-job-id">Job: {jobStatus.id}</span>
                </div>
                <div className={`status-badge ${jobStatus.status}`}>
                  <Activity size={12} className={jobStatus.status === "running" ? "spinner" : ""} />
                  {jobStatus.status}
                </div>
              </div>

              <div className="progress-section">
                <div className="progress-metrics">
                  <span>Processing video frames...</span>
                  <span className="progress-percent">{Math.round(jobStatus.progress * 100)}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-bar" style={{ width: `${jobStatus.progress * 100}%` }}>
                    <div className="progress-bar-shine" />
                  </div>
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Processed Frames</span>
                  <span className="stat-value">{jobStatus.current_frame} / {jobStatus.total_frames || "Estimating..."}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Detected Grid</span>
                  <span className="stat-value">
                    {jobStatus.grid_size 
                      ? `${jobStatus.grid_size.w} × ${jobStatus.grid_size.h}` 
                      : "Scanning First Frame..."}
                  </span>
                </div>
              </div>

              {/* Incremental Preview during running */}
              {frames.length > 0 && (
                <div style={{ marginTop: "10px", textAlign: "center" }}>
                  <div className="player-viewport" style={{ maxHeight: "200px" }}>
                    <img 
                      src={getFrameUrl(currentJobId, frames[frames.length - 1].name)} 
                      alt="Current Process Frame" 
                      className="player-frame-img"
                    />
                    <div className="viewport-overlay">Frame {frames[frames.length - 1].index}</div>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "8px", display: "block" }}>
                    Real-time alignment pipeline preview
                  </span>
                </div>
              )}

              <button className="cancel-btn" onClick={handleCancelJob}>
                <Trash2 size={16} />
                Cancel & Cleanup
              </button>
            </div>
          )}

          {/* STATE 4: PLAYBACK / REVIEW */}
          {currentJobId && jobStatus && (jobStatus.status === "done" || (jobStatus.status === "error" && frames.length > 0)) && (
            <div className="viewer-container">
              <div className="viewer-header">
                <button className="back-home-btn" onClick={handleGoBack}>
                  <ArrowLeft size={14} />
                  Back & Upload New
                </button>
                <div className="viewer-title">
                  <h2>Pixel Perfect Frames</h2>
                  <span className="process-job-id">Job ID: {jobStatus.id}</span>
                </div>
                <div className="status-badge done">
                  <CheckCircle2 size={12} />
                  Complete
                </div>
              </div>

              <div className="player-layout">
                {/* Visual Viewport and controls */}
                <div className="player-main">
                  {frames.length > 0 ? (
                    <>
                      <div className="player-viewport">
                        <img 
                          src={getFrameUrl(currentJobId, frames[currentFrameIndex].name)} 
                          alt={`Processed Frame ${currentFrameIndex}`}
                          className="player-frame-img"
                        />
                        <div className="viewport-overlay">
                          Frame {frames[currentFrameIndex].index} / {frames.length - 1}
                        </div>
                      </div>

                      <div className="player-controls-row">
                        {/* Seek Slider */}
                        <div className="scrubber-container">
                          <input 
                            type="range" 
                            min="0" 
                            max={frames.length - 1} 
                            value={currentFrameIndex} 
                            onChange={(e) => {
                              setIsPlaying(false);
                              setCurrentFrameIndex(parseInt(e.target.value, 10));
                            }}
                          />
                          <span className="current-time-badge">
                            {currentFrameIndex + 1} / {frames.length}
                          </span>
                        </div>

                        {/* Control buttons */}
                        <div className="player-button-group">
                          <div style={{ display: "flex", gap: "8px" }}>
                            <button 
                              className="btn-ctrl" 
                              onClick={() => {
                                setIsPlaying(false);
                                setCurrentFrameIndex(0);
                              }}
                              title="Restart"
                            >
                              <RefreshCw size={16} />
                            </button>
                          </div>

                          <button 
                            className="btn-ctrl play-pause" 
                            onClick={() => setIsPlaying(!isPlaying)}
                            title={isPlaying ? "Pause" : "Play"}
                          >
                            {isPlaying ? <Pause size={20} /> : <Play size={20} style={{ transform: "translateX(1px)" }} />}
                          </button>

                          <div className="playback-speed">
                            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>FPS:</span>
                            <select 
                              className="speed-select" 
                              value={playbackFps}
                              onChange={(e) => setPlaybackFps(parseInt(e.target.value, 10))}
                            >
                              <option value="5">5 FPS</option>
                              <option value="10">10 FPS</option>
                              <option value="15">15 FPS</option>
                              <option value="24">24 FPS</option>
                              <option value="30">30 FPS</option>
                              <option value="60">60 FPS</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                      No frames processed to render.
                    </div>
                  )}
                </div>

                {/* Info and download actions sidebar */}
                <div className="player-sidebar">
                  <div className="info-panel-card">
                    <span className="info-title">Processing Specs</span>
                    <div className="info-grid">
                      <div className="info-row">
                        <span className="info-label">Grid Locked</span>
                        <span className="info-value">
                          {jobStatus.grid_size 
                            ? `${jobStatus.grid_size.w} × ${jobStatus.grid_size.h}` 
                            : "Auto"}
                        </span>
                      </div>
                      <div className="info-row">
                        <span className="info-label">Total Frames</span>
                        <span className="info-value">{frames.length}</span>
                      </div>
                      <div className="info-row">
                        <span className="info-label">Upscale Factor</span>
                        <span className="info-value">{outputScale}x</span>
                      </div>
                      <div className="info-row">
                        <span className="info-label">Sample Rate</span>
                        <span className="info-value">1/{everyNFrames} frames</span>
                      </div>
                    </div>

                    <a 
                      href={`${getBaseUrl()}/api/jobs/${currentJobId}/frames/${frames[currentFrameIndex]?.name}`}
                      download={frames[currentFrameIndex]?.name || "frame.png"}
                      target="_blank"
                      rel="noreferrer"
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <button className="export-btn" style={{ width: "100%" }}>
                        <Download size={16} />
                        Download Frame
                      </button>
                    </a>
                  </div>
                </div>
              </div>

              {/* Frame Sequence Thumbnails Grid */}
              <div className="thumbnails-container">
                <div className="thumbnails-header">
                  <span className="info-title">Frame List (PNG Sequence)</span>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Click to jump to frame</span>
                </div>
                <div className="thumbnails-grid">
                  {frames.map((frame, index) => (
                    <div 
                      key={frame.name}
                      className={`thumbnail-card ${index === currentFrameIndex ? "active" : ""}`}
                      onClick={() => {
                        setIsPlaying(false);
                        setCurrentFrameIndex(index);
                      }}
                    >
                      <img src={getFrameUrl(currentJobId, frame.name)} alt="" loading="lazy" />
                      <span className="thumb-idx">#{frame.index}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
