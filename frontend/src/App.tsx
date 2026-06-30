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
import { translations, Language } from "./i18n";
import { ExportDialog } from "./components/export/ExportDialog";

interface Option<T> {
  value: T;
  label: string;
}

interface CustomSelectProps<T> {
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
  disabled?: boolean;
  className?: string;
}

function CustomSelect<T extends string | number>({
  value,
  onChange,
  options,
  disabled,
  className = "",
}: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const selectedOption = options.find((opt) => opt.value === value);

  return (
    <div
      ref={containerRef}
      className={`custom-select ${className} ${isOpen ? "is-open" : ""} ${
        disabled ? "is-disabled" : ""
      }`}
    >
      <button
        type="button"
        className="custom-select-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <span className="custom-select-value">
          {selectedOption ? selectedOption.label : ""}
        </span>
        <span className="custom-select-icon">
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            style={{
              transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform var(--transition-fast)",
            }}
          >
            <path
              d="M1 1L5 5L9 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {isOpen && (
        <ul className="custom-select-options">
          {options.map((opt) => (
            <li
              key={opt.value}
              className={`custom-select-option ${
                opt.value === value ? "is-selected" : ""
              }`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function App() {
  // Language State
  const [lang, setLang] = useState<Language>(() => {
    const saved = localStorage.getItem("pp_lang");
    return (saved === "en" || saved === "zh") ? saved : "zh";
  });
  const t = translations[lang];

  const handleLangChange = (newLang: Language) => {
    setLang(newLang);
    localStorage.setItem("pp_lang", newLang);
  };

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
  const [adaptiveGrid, setAdaptiveGrid] = useState<boolean>(false);
  const [gridBlend, setGridBlend] = useState<number>(0.7);
  const [temporalSmoothing, setTemporalSmoothing] = useState<boolean>(false);
  const [temporalAlpha, setTemporalAlpha] = useState<number>(0.4);
  const [sceneChangeThreshold, setSceneChangeThreshold] = useState<number>(30.0);
  const [voteFrames, setVoteFrames] = useState<number>(1);
  const [denoise, setDenoise] = useState<boolean>(false);
  const [denoiseStrength, setDenoiseStrength] = useState<number>(5.0);

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
  const [selectedFrames, setSelectedFrames] = useState<number[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  
  // App error states
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Export Dialog visibility state
  const [isExportDialogOpen, setIsExportDialogOpen] = useState<boolean>(false);

  // Interval references
  const playIntervalRef = useRef<number | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  // Scroll and thumbnail sync references
  const isProgrammaticScrollRef = useRef<boolean>(false);
  const isUserScrollingRef = useRef<boolean>(false);
  const thumbnailsContainerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<number | null>(null);

  // Helper state to check if a job is actively processing
  const isProcessing = isSubmitting || !!(currentJobId && jobStatus && (jobStatus.status === "running" || jobStatus.status === "queued"));

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

  // Suppress the webview's default file-drop behaviour at the window level.
  // The dropzone has its own handlers, but a drop that misses it would
  // otherwise make the webview navigate to the file URL (e.g. play a dropped
  // video like a browser). Capture phase + preventDefault kills that default
  // everywhere without affecting the dropzone's React onDrop (preventDefault
  // does not stop other listeners or block reading dataTransfer.files).
  useEffect(() => {
    const killDefault = (e: DragEvent) => {
      e.preventDefault();
    };
    const opts: AddEventListenerOptions = { capture: true };
    window.addEventListener("dragover", killDefault, opts);
    window.addEventListener("drop", killDefault, opts);
    return () => {
      window.removeEventListener("dragover", killDefault, opts);
      window.removeEventListener("drop", killDefault, opts);
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

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
        setVideoPreviewUrl(null);
      };
    } else {
      setVideoPreviewUrl(null);
    }
  }, [file]);

  // 2. Playback control timer
  useEffect(() => {
    if (isPlaying && frames.length > 0) {
      playIntervalRef.current = window.setInterval(() => {
        setCurrentFrameIndex((prevIndex) => {
          if (selectedFrames.length > 0) {
            const sortedSelected = [...selectedFrames].sort((a, b) => a - b);
            const curIdx = sortedSelected.indexOf(prevIndex);
            if (curIdx === -1) {
              const nextLarger = sortedSelected.find(idx => idx >= prevIndex);
              return nextLarger !== undefined ? nextLarger : sortedSelected[0];
            } else if (curIdx >= sortedSelected.length - 1) {
              if (loopPlayback) {
                return sortedSelected[0];
              } else {
                setIsPlaying(false);
                return prevIndex;
              }
            } else {
              return sortedSelected[curIdx + 1];
            }
          } else {
            if (prevIndex >= frames.length - 1) {
              if (loopPlayback) {
                return 0;
              } else {
                setIsPlaying(false);
                return prevIndex;
              }
            }
            return prevIndex + 1;
          }
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
  }, [isPlaying, frames, playbackFps, loopPlayback, selectedFrames]);

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
            setErrorMsg(status.error || t.processingError);
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

  // Scroll handler for manual wheel/drag scrolling
  const handleThumbnailsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    // If the scroll is triggered programmatically by playback or scrubbing, ignore it
    if (isProgrammaticScrollRef.current) return;

    const container = e.currentTarget;
    const scrollTop = container.scrollTop;
    const containerHeight = container.clientHeight;
    
    // Calculate which child is closest to the vertical center of the container
    const children = Array.from(container.children) as HTMLElement[];
    if (children.length === 0) return;

    const containerCenter = scrollTop + containerHeight / 2;
    
    let closestIndex = 0;
    let minDistance = Infinity;

    children.forEach((child, index) => {
      const childCenter = child.offsetTop + child.offsetHeight / 2;
      const distance = Math.abs(containerCenter - childCenter);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = index;
      }
    });

    if (closestIndex !== currentFrameIndex) {
      isUserScrollingRef.current = true;
      setCurrentFrameIndex(closestIndex);
      
      // Reset user scrolling flag after scroll stops
      if (scrollTimeoutRef.current) {
        window.clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = window.setTimeout(() => {
        isUserScrollingRef.current = false;
      }, 150);
    }
  };

  // Programmatic scroll effect to center active frame
  useEffect(() => {
    if (isUserScrollingRef.current) {
      // If the change came from the user scrolling the thumbnails list,
      // do not scroll programmatically (the item is already centered by snap)
      return;
    }

    const container = thumbnailsContainerRef.current;
    if (container && frames.length > 0) {
      const children = Array.from(container.children) as HTMLElement[];
      const activeChild = children[currentFrameIndex];
      
      if (activeChild) {
        isProgrammaticScrollRef.current = true;
        
        const containerHeight = container.clientHeight;
        const targetTop = activeChild.offsetTop - (containerHeight / 2) + (activeChild.offsetHeight / 2);
        
        container.scrollTo({
          top: targetTop,
          behavior: "smooth"
        });

        // Set programmatic scroll flag to false after scroll completes
        if (scrollTimeoutRef.current) {
          window.clearTimeout(scrollTimeoutRef.current);
        }
        scrollTimeoutRef.current = window.setTimeout(() => {
          isProgrammaticScrollRef.current = false;
        }, 300); // 300ms matches scroll animation length
      }
    }
  }, [currentFrameIndex, frames]);

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
        setErrorMsg(t.invalidFormat);
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

    // If we have an existing job, delete/cancel it first to clean up resources
    if (currentJobId) {
      try {
        await deleteJob(currentJobId);
      } catch (e) {
        console.error("Cleanup old job error:", e);
      }
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setFrames([]);
    setSelectedFrames([]);
    setLastSelectedIndex(null);
    setCurrentFrameIndex(0);
    setIsPlaying(false);

    const options: JobOptions = {
      sample_method: sampleMethod,
      grid_size_w: gridSizeW ? parseInt(gridSizeW, 10) : null,
      grid_size_h: gridSizeH ? parseInt(gridSizeH, 10) : null,
      refine_intensity: refineIntensity,
      fix_square: fixSquare,
      min_size: minSize,
      peak_width: peakWidth,
      output_scale: outputScale,
      every_n_frames: everyNFrames,
      adaptive_grid: adaptiveGrid,
      grid_blend: gridBlend,
      temporal_smoothing: temporalSmoothing,
      temporal_alpha: temporalAlpha,
      scene_change_threshold: sceneChangeThreshold,
      vote_frames: voteFrames,
      denoise: denoise,
      denoise_strength: denoiseStrength,
    };

    try {
      const response = await createJob(file, options);
      setCurrentJobId(response.job_id);
    } catch (e: any) {
      setErrorMsg(e.message || t.failedInitJob);
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
      setSelectedFrames([]);
      setLastSelectedIndex(null);
      setCurrentFrameIndex(0);
      setIsPlaying(false);
      setErrorMsg(null);
    }
  };

  // Go back to config
  const handleGoBack = () => {
    if (currentJobId) {
      handleCancelJob();
    }
    setFile(null);
    setErrorMsg(null);
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
          {isError ? t.engineFailed : t.initializingEngine}
        </div>
        <div style={{ fontSize: 13, opacity: 0.6, maxWidth: 380, textAlign: "center" }}>
          {isError
            ? t.backendLaunchError
            : t.startingBackend}
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
            {t.openLogsDir}
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
          <div className="logo-area" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="logo-icon">
                <Sparkles size={18} />
              </div>
              <span className="logo-text">Perfect Pixel</span>
              <span className="logo-version">v1.1</span>
            </div>
            {/* Language Switcher */}
            <CustomSelect
              value={lang}
              onChange={(val) => handleLangChange(val as Language)}
              options={[
                { value: "zh", label: "中文" },
                { value: "en", label: "EN" },
              ]}
              className="lang-select-custom"
            />
          </div>
          <div className="connection-status">
            <div className={`status-dot ${isApiConnected ? "connected" : "disconnected"}`} />
            <span>
              {isApiConnected === null 
                ? t.checkingServer 
                : isApiConnected 
                  ? t.backendConnected 
                  : t.backendOffline}
            </span>
          </div>
        </div>

        {/* Configurations Form */}
        <div className="settings-form">
          <div className="settings-section-title">{t.coreAlgorithm}</div>
          
          <div className="form-group">
            <label>
              {t.sampleMethod}
              <span className="label-hint">sample_method</span>
            </label>
            <CustomSelect
              value={sampleMethod}
              onChange={(val) => setSampleMethod(val as any)}
              options={[
                { value: "majority", label: t.majorityColor },
                { value: "center", label: t.centerSampling },
                { value: "median", label: t.medianColor },
              ]}
              disabled={isProcessing}
            />
          </div>

          <div className="form-group">
            <label>
              {t.gridDimensions}
              <span className="label-hint">grid_size</span>
            </label>
            <div className="form-group-row">
              <input 
                type="number" 
                placeholder={t.autoWidth} 
                value={gridSizeW} 
                onChange={(e) => setGridSizeW(e.target.value)}
                disabled={isProcessing}
                min="1"
              />
              <input 
                type="number" 
                placeholder={t.autoHeight} 
                value={gridSizeH} 
                onChange={(e) => setGridSizeH(e.target.value)}
                disabled={isProcessing}
                min="1"
              />
            </div>
          </div>

          <div className="form-group">
            <label>
              {t.refineIntensity}: <span className="slider-val">{refineIntensity.toFixed(2)}</span>
            </label>
            <div className="slider-container">
              <input 
                type="range" 
                min="0.0" 
                max="0.5" 
                step="0.01" 
                value={refineIntensity} 
                onChange={(e) => setRefineIntensity(parseFloat(e.target.value))}
                disabled={isProcessing}
              />
            </div>
          </div>

          <div className="form-group">
            <label>
              {t.voteFrames}
              <span className="label-hint">vote_frames</span>
            </label>
            <CustomSelect
              value={voteFrames}
              onChange={(val) => setVoteFrames(val)}
              options={[
                { value: 0, label: "0 (No Voting)" },
                { value: 1, label: "1 (Single Frame)" },
                { value: 3, label: "3 (3 Frames)" },
                { value: 5, label: "5 (5 Frames)" },
                { value: 10, label: "10 (10 Frames)" },
              ]}
              disabled={isProcessing}
            />
          </div>

          <div className="settings-section-title">{t.videoSizing}</div>

          <div className="form-group">
            <label>
              {t.outputUpscaleFactor}: <span className="slider-val">{outputScale}x</span>
            </label>
            <div className="slider-container">
              <input 
                type="range" 
                min="1" 
                max="16" 
                step="1" 
                value={outputScale} 
                onChange={(e) => setOutputScale(parseInt(e.target.value, 10))}
                disabled={isProcessing}
              />
            </div>
          </div>

          <div className="form-group-row">
            <div className="form-group">
              <label>{t.minPixelSize}</label>
              <input 
                type="number" 
                value={minSize} 
                onChange={(e) => setMinSize(parseFloat(e.target.value))}
                disabled={isProcessing}
                min="1" 
                step="0.5"
              />
            </div>
            <div className="form-group">
              <label>{t.peakWidth}</label>
              <input 
                type="number" 
                value={peakWidth} 
                onChange={(e) => setPeakWidth(parseInt(e.target.value, 10))}
                disabled={isProcessing}
                min="1"
              />
            </div>
          </div>

          <div className="form-group">
            <label>
              {t.frameSamplingStep}
              <span className="label-hint">every_n_frames</span>
            </label>
            <input 
              type="number" 
              value={everyNFrames} 
              onChange={(e) => setEveryNFrames(parseInt(e.target.value, 10))}
              disabled={isProcessing}
              min="1"
            />
          </div>

          <div className="settings-section-title">{t.featureSwitches}</div>

          <div className="form-group toggle-group">
            <label htmlFor="toggle-fix-square" style={{ cursor: "pointer" }}>{t.forceSquareAlignment}</label>
            <label className="toggle-switch">
              <input 
                id="toggle-fix-square"
                type="checkbox" 
                checked={fixSquare} 
                onChange={(e) => !isProcessing && setFixSquare(e.target.checked)} 
                disabled={isProcessing} 
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="form-group toggle-group">
            <label htmlFor="toggle-adaptive-grid" style={{ cursor: "pointer" }}>{t.adaptiveGrid}</label>
            <label className="toggle-switch">
              <input 
                id="toggle-adaptive-grid"
                type="checkbox" 
                checked={adaptiveGrid} 
                onChange={(e) => !isProcessing && setAdaptiveGrid(e.target.checked)} 
                disabled={isProcessing} 
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="form-group toggle-group">
            <label htmlFor="toggle-temporal-smoothing" style={{ cursor: "pointer" }}>{t.temporalSmoothing}</label>
            <label className="toggle-switch">
              <input 
                id="toggle-temporal-smoothing"
                type="checkbox" 
                checked={temporalSmoothing} 
                onChange={(e) => !isProcessing && setTemporalSmoothing(e.target.checked)} 
                disabled={isProcessing} 
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="form-group toggle-group">
            <label htmlFor="toggle-denoise" style={{ cursor: "pointer" }}>{t.denoise}</label>
            <label className="toggle-switch">
              <input 
                id="toggle-denoise"
                type="checkbox" 
                checked={denoise} 
                onChange={(e) => !isProcessing && setDenoise(e.target.checked)} 
                disabled={isProcessing} 
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {(adaptiveGrid || temporalSmoothing || denoise) && (
            <>
              <div className="settings-section-title">{t.advancedSettings}</div>

              {adaptiveGrid && (
                <div className="form-group">
                  <label>
                    {t.gridBlend}: <span className="slider-val">{gridBlend.toFixed(2)}</span>
                  </label>
                  <div className="slider-container">
                    <input 
                      type="range" 
                      min="0.0" 
                      max="1.0" 
                      step="0.05" 
                      value={gridBlend} 
                      onChange={(e) => setGridBlend(parseFloat(e.target.value))}
                      disabled={isProcessing}
                    />
                  </div>
                </div>
              )}

              {temporalSmoothing && (
                <>
                  <div className="form-group">
                    <label>
                      {t.temporalAlpha}: <span className="slider-val">{temporalAlpha.toFixed(2)}</span>
                    </label>
                    <div className="slider-container">
                      <input 
                        type="range" 
                        min="0.05" 
                        max="1.0" 
                        step="0.05" 
                        value={temporalAlpha} 
                        onChange={(e) => setTemporalAlpha(parseFloat(e.target.value))}
                        disabled={isProcessing}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>
                      {t.sceneChangeThreshold}: <span className="slider-val">{sceneChangeThreshold.toFixed(0)}</span>
                    </label>
                    <div className="slider-container">
                      <input 
                        type="range" 
                        min="5" 
                        max="100" 
                        step="5" 
                        value={sceneChangeThreshold} 
                        onChange={(e) => setSceneChangeThreshold(parseFloat(e.target.value))}
                        disabled={isProcessing}
                      />
                    </div>
                  </div>
                </>
              )}

              {denoise && (
                <div className="form-group">
                  <label>
                    {t.denoiseStrength}: <span className="slider-val">{denoiseStrength.toFixed(1)}</span>
                  </label>
                  <div className="slider-container">
                    <input 
                      type="range" 
                      min="1.0" 
                      max="15.0" 
                      step="0.5" 
                      value={denoiseStrength} 
                      onChange={(e) => setDenoiseStrength(parseFloat(e.target.value))}
                      disabled={isProcessing}
                    />
                  </div>
                </div>
              )}
            </>
          )}

        </div>

        {/* Action Button inside Sidebar (Fixed at bottom) */}
        {file && (
          <div className="sidebar-actions">
            <button 
              className="submit-btn" 
              onClick={handleStartProcessing} 
              disabled={isProcessing || !isApiConnected}
            >
              {isProcessing ? (
                <>
                  <span className="spinner" />
                  {t.initializingJob}
                </>
              ) : currentJobId ? (
                <>
                  <Sparkles size={18} />
                  {t.regeneratePixelArt}
                </>
              ) : (
                <>
                  <Sparkles size={18} />
                  {t.processToPixelArt}
                </>
              )}
            </button>
          </div>
        )}

        <div className="sidebar-footer">
          <div className="version-note">{t.tauriSidecarIntegration}</div>
        </div>
      </aside>

      {/* MAIN PANEL */}
      <main className="main-panel">
        {/* Offline Alert Banner */}
        {isApiConnected === false && (
          <div className="alert-banner">
            <AlertTriangle size={18} />
            <div>
              <strong>{t.fastapiOffline}</strong> {t.activateVenv} <code>python -m api.run</code>
            </div>
            <button className="alert-banner-btn" onClick={verifyBackendHealth}>
              {isCheckingConnection ? t.checking : t.reconnect}
            </button>
          </div>
        )}

        <div className="workspace">
          {errorMsg && (
            <div className="alert-banner" style={{ background: "rgba(255, 84, 112, 0.15)", borderColor: "rgba(255, 84, 112, 0.2)", color: "#ff8a9e", borderRadius: "12px", width: "100%", maxWidth: "680px", marginBottom: "20px" }}>
              <AlertTriangle size={18} />
              <div><strong>{t.errorPrefix}</strong> {errorMsg}</div>
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
              <h3 className="dropzone-title">{t.uploadVideoFile}</h3>
              <p className="dropzone-desc">{t.dragDropDesc}</p>
              <button className="browse-btn">{t.browseFiles}</button>
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

              {videoPreviewUrl && (
                <div className="video-preview-container" style={{ margin: "16px 0", borderRadius: "8px", overflow: "hidden", border: "1px solid var(--border-color)", background: "#000" }}>
                  <video
                    src={videoPreviewUrl}
                    controls
                    style={{ width: "100%", maxHeight: "240px", display: "block" }}
                  />
                </div>
              )}

              <button 
                className="submit-btn" 
                onClick={handleStartProcessing} 
                disabled={isSubmitting || !isApiConnected}
              >
                {isSubmitting ? (
                  <>
                    <span className="spinner" />
                    {t.initializingJob}
                  </>
                ) : (
                  <>
                    <Sparkles size={18} />
                    {t.processToPixelArt}
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
                  <h3 className="process-title">{t.aligningGridColor}</h3>
                  <span className="process-job-id">{t.jobPrefix} {jobStatus.id}</span>
                </div>
                <div className={`status-badge ${jobStatus.status}`}>
                  <Activity size={12} className={jobStatus.status === "running" ? "spinner" : ""} />
                  {jobStatus.status}
                </div>
              </div>

              <div className="progress-section">
                <div className="progress-metrics">
                  <span>{t.processingFrames}</span>
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
                  <span className="stat-label">{t.processedFrames}</span>
                  <span className="stat-value">{jobStatus.current_frame} / {jobStatus.total_frames || t.estimating}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{t.detectedGrid}</span>
                  <span className="stat-value">
                    {jobStatus.grid_size 
                      ? `${jobStatus.grid_size.w} × ${jobStatus.grid_size.h}` 
                      : t.scanningFirstFrame}
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
                    <div className="viewport-overlay">{t.frameText} {frames[frames.length - 1].index}</div>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "8px", display: "block" }}>
                    {t.realtimePreview}
                  </span>
                </div>
              )}

              <button className="cancel-btn" onClick={handleCancelJob}>
                <Trash2 size={16} />
                {t.cancelCleanup}
              </button>
            </div>
          )}

          {/* STATE 4: PLAYBACK / REVIEW */}
          {currentJobId && jobStatus && (jobStatus.status === "done" || (jobStatus.status === "error" && frames.length > 0)) && (
            <div className="viewer-container">
              <div className="viewer-header">
                <button className="back-home-btn" onClick={handleGoBack}>
                  <ArrowLeft size={14} />
                  {t.backUploadNew}
                </button>
                <div className="viewer-title">
                  <h2>{t.pixelPerfectFrames}</h2>
                  <span className="process-job-id">{t.jobIdPrefix} {jobStatus.id}</span>
                </div>
                <div className="status-badge done">
                  <CheckCircle2 size={12} />
                  {t.complete}
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
                          {t.frameText} {frames[currentFrameIndex].index} / {frames.length - 1}
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
                              title={t.restart}
                            >
                              <RefreshCw size={16} />
                            </button>
                          </div>

                          <button 
                            className="btn-ctrl play-pause" 
                            onClick={() => setIsPlaying(!isPlaying)}
                            title={isPlaying ? t.pause : t.play}
                          >
                            {isPlaying ? <Pause size={20} /> : <Play size={20} style={{ transform: "translateX(1px)" }} />}
                          </button>

                          <div className="playback-speed">
                            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.fps}</span>
                            <CustomSelect
                              value={playbackFps}
                              onChange={(val) => setPlaybackFps(val)}
                              options={[
                                { value: 5, label: "5 FPS" },
                                { value: 10, label: "10 FPS" },
                                { value: 15, label: "15 FPS" },
                                { value: 24, label: "24 FPS" },
                                { value: 30, label: "30 FPS" },
                                { value: 60, label: "60 FPS" },
                              ]}
                              className="speed-select-custom"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Info Specifications Panel (Horizontal block under video controls) */}
                      <div className="info-panel-card">
                        <div className="info-grid">
                          <div className="info-row">
                            <span className="info-label">{t.gridLocked}</span>
                            <span className="info-value">
                              {jobStatus.grid_size 
                                ? `${jobStatus.grid_size.w} × ${jobStatus.grid_size.h}` 
                                : t.auto}
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">{t.totalFrames}</span>
                            <span className="info-value">{frames.length}</span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">{t.upscaleFactor}</span>
                            <span className="info-value">{outputScale}x</span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">{t.sampleRate}</span>
                            <span className="info-value">{t.sampleRateValue(everyNFrames)}</span>
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: "12px" }}>
                          <button
                            className="export-btn"
                            style={{ background: "var(--accent-green)", color: "#121212" }}
                            onClick={() => setIsExportDialogOpen(true)}
                          >
                            <Sparkles size={16} />
                            {t.exportBtnText}
                          </button>

                          <a 
                            href={`${getBaseUrl()}/api/jobs/${currentJobId}/frames/${frames[currentFrameIndex]?.name}`}
                            download={frames[currentFrameIndex]?.name || "frame.png"}
                            target="_blank"
                            rel="noreferrer"
                            style={{ textDecoration: "none", color: "inherit" }}
                          >
                            <button className="export-btn" style={{ background: "transparent", color: "#fff", border: "1px solid var(--border-color)" }}>
                              <Download size={16} />
                              {t.downloadFrame}
                            </button>
                          </a>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                      {t.noFramesRender}
                    </div>
                  )}
                </div>

                {/* Info and download actions sidebar */}
                <div className="player-sidebar">
                  {/* Frame Sequence Thumbnails Column */}
                  <div className="thumbnails-container">
                    <div className="thumbnails-header" style={{ flexDirection: "column", gap: "6px", alignItems: "stretch" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span className="info-title">{t.frameListPng}</span>
                        <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                          Selected: {selectedFrames.length}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "8px", marginTop: "2px" }}>
                        <button
                          type="button"
                          className="thumbnails-action-btn"
                          style={{ flex: 1, textAlign: "center" }}
                          onClick={() => setSelectedFrames(frames.map(f => f.index))}
                        >
                          {t.selectAll}
                        </button>
                        <button
                          type="button"
                          className="thumbnails-action-btn"
                          style={{ flex: 1, textAlign: "center" }}
                          onClick={() => setSelectedFrames([])}
                        >
                          {t.clearAll}
                        </button>
                      </div>
                    </div>
                    <div 
                      ref={thumbnailsContainerRef}
                      className="thumbnails-grid"
                      onScroll={handleThumbnailsScroll}
                    >
                      {frames.map((frame, index) => {
                        const isSelected = selectedFrames.includes(frame.index);
                        return (
                          <div 
                            key={frame.name}
                            className={`thumbnail-card ${index === currentFrameIndex ? "active" : ""} ${isSelected ? "selected" : ""}`}
                            style={{ position: "relative", cursor: "pointer" }}
                            onClick={(e) => {
                              const target = e.target as HTMLElement;
                              if (target.closest(".thumb-select-box")) {
                                return;
                              }
                              
                              if (e.shiftKey && lastSelectedIndex !== null) {
                                const isClickingToSelect = !isSelected;
                                const start = Math.min(lastSelectedIndex, frame.index);
                                const end = Math.max(lastSelectedIndex, frame.index);
                                const rangeIndices: number[] = [];
                                for (let i = start; i <= end; i++) {
                                  rangeIndices.push(i);
                                }
                                
                                if (isClickingToSelect) {
                                  setSelectedFrames(prev => {
                                    const newSelection = [...prev];
                                    rangeIndices.forEach(idx => {
                                      if (!newSelection.includes(idx)) {
                                        newSelection.push(idx);
                                      }
                                    });
                                    return newSelection;
                                  });
                                } else {
                                  setSelectedFrames(prev => prev.filter(idx => !rangeIndices.includes(idx)));
                                }
                              } else {
                                setIsPlaying(false);
                                setCurrentFrameIndex(index);
                              }
                              
                              setLastSelectedIndex(frame.index);
                            }}
                          >
                            <img src={getFrameUrl(currentJobId, frame.name)} alt="" loading="lazy" />
                            <span className="thumb-idx">#{frame.index}</span>
                            <div 
                              className={`thumb-select-box ${isSelected ? "checked" : ""}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                const isClickingToSelect = !isSelected;
                                if (e.shiftKey && lastSelectedIndex !== null) {
                                  const start = Math.min(lastSelectedIndex, frame.index);
                                  const end = Math.max(lastSelectedIndex, frame.index);
                                  const rangeIndices: number[] = [];
                                  for (let i = start; i <= end; i++) {
                                    rangeIndices.push(i);
                                  }
                                  
                                  if (isClickingToSelect) {
                                    setSelectedFrames(prev => {
                                      const newSelection = [...prev];
                                      rangeIndices.forEach(idx => {
                                        if (!newSelection.includes(idx)) {
                                          newSelection.push(idx);
                                        }
                                      });
                                      return newSelection;
                                    });
                                  } else {
                                    setSelectedFrames(prev => prev.filter(idx => !rangeIndices.includes(idx)));
                                  }
                                } else {
                                  if (isSelected) {
                                    setSelectedFrames(prev => prev.filter(i => i !== frame.index));
                                  } else {
                                    setSelectedFrames(prev => [...prev, frame.index]);
                                  }
                                }
                                setLastSelectedIndex(frame.index);
                              }}
                            >
                              <CheckCircle2 size={12} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
      {isExportDialogOpen && currentJobId && (
        <ExportDialog
          jobId={currentJobId}
          frames={frames}
          currentFrameIndex={currentFrameIndex}
          selectedFrames={selectedFrames}
          onClose={() => setIsExportDialogOpen(false)}
          t={t}
          lang={lang}
        />
      )}
    </div>
  );
}

export default App;
