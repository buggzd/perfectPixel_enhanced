import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  checkHealth,
  analyzeJobKeyframes,
  createJob,
  getJobStatus,
  getJobFrames,
  getFrameUrl,
  getBackgroundPreviewUrl,
  applyBackgroundRemoval,
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
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  UploadCloud, 
  Video, 
  AlertTriangle, 
  CheckCircle2, 
  Trash2, 
  Activity, 
  Sparkles, 
  ArrowLeft, 
  Download,
  Eraser,
  Pipette
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

interface ParamHelp {
  main: string;
  tech?: string;
}

interface TooltipLabelProps {
  children: React.ReactNode;
  help: ParamHelp;
  value?: React.ReactNode;
  htmlFor?: string;
  style?: React.CSSProperties;
  className?: string;
}

function TooltipLabel({ children, help, value, htmlFor, style, className = "" }: TooltipLabelProps) {
  return (
    <label htmlFor={htmlFor} className={`tooltip-label ${className}`} style={style}>
      <span className="tooltip-anchor" tabIndex={0}>
        {children}
        <span className="tooltip-popover" role="tooltip">
          <span>{help.main}</span>
          {help.tech && <small>{help.tech}</small>}
        </span>
      </span>
      {value}
    </label>
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
  const [selectionEveryN, setSelectionEveryN] = useState<number>(4);
  const [keyframeThreshold, setKeyframeThreshold] = useState<number>(8);
  const [keyframeMethod, setKeyframeMethod] = useState<"adjacent" | "flow">("adjacent");
  const [isAnalyzingKeyframes, setIsAnalyzingKeyframes] = useState<boolean>(false);
  const [reviewStep, setReviewStep] = useState<"background" | "frames">("background");
  const [autoBackground, setAutoBackground] = useState<boolean>(true);
  const [backgroundColor, setBackgroundColor] = useState<string>("#000000");
  const [backgroundThreshold, setBackgroundThreshold] = useState<number>(30.0);
  const [backgroundFeather, setBackgroundFeather] = useState<number>(0);
  const [isPickingBackground, setIsPickingBackground] = useState<boolean>(false);
  const [isApplyingBackground, setIsApplyingBackground] = useState<boolean>(false);
  const backgroundSourceImgRef = useRef<HTMLImageElement>(null);

  // When frames are selected, playback (scrubber + count + play loop) is
  // confined to that subset. Sorted selected frame indices form the active
  // playback set; currentFrameIndex is mapped to its position within it.
  const sortedSelectedFrames = useMemo(
    () => (selectedFrames.length > 0 ? [...selectedFrames].sort((a, b) => a - b) : []),
    [selectedFrames]
  );
  const allFrameIndices = useMemo(() => frames.map((frame) => frame.index), [frames]);
  const selectedFrameSet = useMemo(() => new Set(selectedFrames), [selectedFrames]);
  const hasSelection = sortedSelectedFrames.length > 0;
  const playbackFrameIndices = hasSelection ? sortedSelectedFrames : allFrameIndices;
  const playbackPos = playbackFrameIndices.indexOf(currentFrameIndex);
  const playbackCount = playbackFrameIndices.length;
  const backgroundBlockSize = Math.max(1, outputScale);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  
  // App error states
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Export Dialog visibility state
  const [isExportDialogOpen, setIsExportDialogOpen] = useState<boolean>(false);

  // Interval references
  const playIntervalRef = useRef<number | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  // Scroll and thumbnail sync references
  const thumbnailsContainerRef = useRef<HTMLDivElement>(null);
  const settingsFormRef = useRef<HTMLDivElement>(null);

  // Scroll animation state refs
  const thumbnailsInertiaVelocity = useRef<number>(0);
  const thumbnailsInertiaFrameId = useRef<number | null>(null);
  const thumbnailsInertiaIsMoving = useRef<boolean>(false);
  const thumbnailsLastWheelTime = useRef<number>(0);
  const thumbnailsAlignmentFrameId = useRef<number | null>(null);

  // Helper state to check if a job is actively processing
  const isProcessing = isSubmitting || !!(currentJobId && jobStatus && (jobStatus.status === "running" || jobStatus.status === "queued"));
  const thumbnailItemHeight = 102;

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
    if (isPlaying && playbackFrameIndices.length > 0) {
      playIntervalRef.current = window.setInterval(() => {
        setCurrentFrameIndex((prevIndex) => {
          const curIdx = playbackFrameIndices.indexOf(prevIndex);
          if (curIdx === -1) {
            const nextLarger = playbackFrameIndices.find(idx => idx >= prevIndex);
            return nextLarger !== undefined ? nextLarger : playbackFrameIndices[0];
          }
          if (curIdx >= playbackFrameIndices.length - 1) {
            if (loopPlayback) return playbackFrameIndices[0];
            setIsPlaying(false);
            return prevIndex;
          }
          return playbackFrameIndices[curIdx + 1];
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
  }, [isPlaying, playbackFrameIndices, playbackFps, loopPlayback]);

  // 3. Status Poll effect
  useEffect(() => {
    if (currentJobId) {
      pollIntervalRef.current = window.setInterval(async () => {
        try {
          const status = await getJobStatus(currentJobId);
          setJobStatus(status);

          // Keep the polling payload small; refresh the frame list only when
          // the backend reports that new frames are available.
          if (status.output_frame_count > 0) {
            setFrames((prev) => {
              if (prev.length === status.output_frame_count) return prev;
              const next: FrameInfo[] = [];
              for (let i = 0; i < status.output_frame_count; i += 1) {
                next.push({
                  name: `frame_${i.toString().padStart(6, "0")}.png`,
                  index: i,
                });
              }
              return next;
            });
          }

          if (status.status === "done") {
            // Fetch complete final list just to be sure
            const finalFrames = await getJobFrames(currentJobId);
            const sortedFrames = [...finalFrames.frames].sort((a, b) => a.index - b.index);
            setFrames(sortedFrames);
            setCurrentFrameIndex(0);
            if (isApplyingBackground || status.stage === "background_removal") {
              setIsApplyingBackground(false);
              setReviewStep("frames");
            } else if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
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
  }, [currentJobId, isApplyingBackground]);

  // Programmatic scroll: place the active frame in the 2nd visible slot,
  // keeping the previous frame visible above it. The first frame clamps to the
  // top because nothing precedes it.
  //
  // Manual wheel scrolling is intentionally NOT coupled to the active frame:
  // scrolling just pans the list and may move the active frame out of view.
  // The active frame only moves via play / scrubber / click, which re-triggers
  // this effect.
  // Programmatic scroll: place the active frame in the 2nd visible slot,
  // keeping the previous frame visible above it. The first frame clamps to the
  // top because nothing precedes it.
  //
  // Manual wheel scrolling is intentionally NOT coupled to the active frame:
  // scrolling just pans the list and may move the active frame out of view.
  // The active frame only moves via play / scrubber / click, which re-triggers
  // this effect.
  useEffect(() => {
    const container = thumbnailsContainerRef.current;
    if (!container || frames.length === 0) return;
    const elapsedSinceWheel = performance.now() - thumbnailsLastWheelTime.current;
    if (elapsedSinceWheel < 900) return;

    // Cancel any running alignment animation
    if (thumbnailsAlignmentFrameId.current) {
      cancelAnimationFrame(thumbnailsAlignmentFrameId.current);
      thumbnailsAlignmentFrameId.current = null;
    }

    const targetTop = Math.max(0, currentFrameIndex * thumbnailItemHeight - thumbnailItemHeight);

    // Custom Ease-Out Scroll Animation (先快后慢)
    const easeFactor = 0.16; // Speed coefficient (0.15 - 0.20 is standard ease-out)
    
    const animateAlignment = () => {
      const currentScroll = container.scrollTop;
      const diff = targetTop - currentScroll;

      if (Math.abs(diff) < 0.5) {
        container.scrollTop = targetTop;
        thumbnailsAlignmentFrameId.current = null;
        return;
      }

      container.scrollTop = currentScroll + diff * easeFactor;
      thumbnailsAlignmentFrameId.current = requestAnimationFrame(animateAlignment);
    };

    thumbnailsAlignmentFrameId.current = requestAnimationFrame(animateAlignment);

    return () => {
      if (thumbnailsAlignmentFrameId.current) {
        cancelAnimationFrame(thumbnailsAlignmentFrameId.current);
      }
    };
  }, [currentFrameIndex, frames.length]);

  // 2b. Custom smooth wheel scrolling with momentum/inertia for frames list.
  useEffect(() => {
    const container = thumbnailsContainerRef.current;
    if (!container) return;

    const friction = 0.94;
    const speedMultiplier = 0.68;
    const maxVelocity = 76;

    const updateScroll = () => {
      const velocity = thumbnailsInertiaVelocity.current;
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);

      if (Math.abs(velocity) < 0.15) {
        thumbnailsInertiaVelocity.current = 0;
        thumbnailsInertiaIsMoving.current = false;
        thumbnailsInertiaFrameId.current = null;
        return;
      }

      const nextTop = Math.max(0, Math.min(maxScrollTop, container.scrollTop + velocity));
      const hitEdge = (nextTop === 0 && velocity < 0) || (nextTop === maxScrollTop && velocity > 0);
      container.scrollTop = nextTop;
      thumbnailsInertiaVelocity.current = hitEdge ? 0 : velocity * friction;
      thumbnailsInertiaFrameId.current = requestAnimationFrame(updateScroll);
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      thumbnailsLastWheelTime.current = performance.now();

      // Interrupt active-frame alignment while the user is manually scrolling.
      if (thumbnailsAlignmentFrameId.current) {
        cancelAnimationFrame(thumbnailsAlignmentFrameId.current);
        thumbnailsAlignmentFrameId.current = null;
      }

      const normalizedDelta = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY * 16
        : e.deltaY;

      thumbnailsInertiaVelocity.current += normalizedDelta * speedMultiplier;
      thumbnailsInertiaVelocity.current = Math.max(
        -maxVelocity,
        Math.min(maxVelocity, thumbnailsInertiaVelocity.current)
      );

      if (!thumbnailsInertiaIsMoving.current) {
        thumbnailsInertiaIsMoving.current = true;
        if (thumbnailsInertiaFrameId.current) {
          cancelAnimationFrame(thumbnailsInertiaFrameId.current);
        }
        thumbnailsInertiaFrameId.current = requestAnimationFrame(updateScroll);
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheel);
      if (thumbnailsInertiaFrameId.current) {
        cancelAnimationFrame(thumbnailsInertiaFrameId.current);
        thumbnailsInertiaFrameId.current = null;
      }
    };
  }, [frames.length, reviewStep]);

  // 2c. Custom smooth wheel scrolling with momentum/inertia for settings panel
  useEffect(() => {
    const container = settingsFormRef.current;
    if (!container) return;

    let velocityY = 0;
    let isMoving = false;
    let animationFrameId: number | null = null;
    const friction = 0.94; // Decay factor per frame
    const speedMultiplier = 0.65; // Scroll sensitivity multiplier

    const updateScroll = () => {
      if (Math.abs(velocityY) < 0.15) {
        velocityY = 0;
        isMoving = false;
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        return;
      }

      container.scrollTop += velocityY;
      velocityY *= friction;

      animationFrameId = requestAnimationFrame(updateScroll);
    };

    const handleWheel = (e: WheelEvent) => {
      // Intercept raw wheel events to apply custom inertia physics
      e.preventDefault();

      // Accumulate velocity
      velocityY += e.deltaY * speedMultiplier;

      // Clamp velocity to prevent extreme scrolling speed
      const maxVelocity = 75;
      if (velocityY > maxVelocity) velocityY = maxVelocity;
      if (velocityY < -maxVelocity) velocityY = -maxVelocity;

      if (!isMoving) {
        isMoving = true;
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        animationFrameId = requestAnimationFrame(updateScroll);
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheel);
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [bootState]);

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

  const jumpPlaybackTo = (target: "first" | "last") => {
    if (playbackFrameIndices.length === 0) return;
    setIsPlaying(false);
    setCurrentFrameIndex(target === "first" ? playbackFrameIndices[0] : playbackFrameIndices[playbackFrameIndices.length - 1]);
  };

  const stepPlaybackBy = (delta: -1 | 1) => {
    if (playbackFrameIndices.length === 0) return;
    setIsPlaying(false);
    const currentPos = playbackFrameIndices.indexOf(currentFrameIndex);
    const nextPos = currentPos === -1
      ? (delta > 0 ? 0 : playbackFrameIndices.length - 1)
      : Math.max(0, Math.min(playbackFrameIndices.length - 1, currentPos + delta));
    setCurrentFrameIndex(playbackFrameIndices[nextPos]);
  };

  const handleSelectEveryNFrames = () => {
    const stride = Math.max(1, Math.floor(selectionEveryN || 1));
    const nextSelection = frames
      .filter((_frame, index) => index % stride === 0)
      .map((frame) => frame.index);
    setIsPlaying(false);
    setSelectedFrames(nextSelection);
    setLastSelectedIndex(nextSelection.length ? nextSelection[nextSelection.length - 1] : null);
  };

  const handleAutoSelectKeyframes = async () => {
    if (!currentJobId || frames.length === 0) return;
    setIsAnalyzingKeyframes(true);
    setErrorMsg(null);
    setIsPlaying(false);
    try {
      const result = await analyzeJobKeyframes(currentJobId, {
        threshold: keyframeThreshold,
        method: keyframeMethod,
      });
      const nextFrames = [...result.frames].sort((a, b) => a.index - b.index);
      setFrames(nextFrames);
      const nextSelection = nextFrames
        .filter((frame) => frame.is_keyframe)
        .map((frame) => frame.index);
      setSelectedFrames(nextSelection);
      setLastSelectedIndex(nextSelection[nextSelection.length - 1] ?? null);
    } catch (e: any) {
      setErrorMsg(e.message || t.keyframeSelectionFailed);
    } finally {
      setIsAnalyzingKeyframes(false);
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
    setReviewStep("background");
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
      setReviewStep("background");
      setIsPlaying(false);
      setErrorMsg(null);
    }
  };

  const handleSkipBackground = () => {
    setReviewStep("frames");
    setCurrentFrameIndex(0);
  };

  const handlePickBackgroundColor = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!isPickingBackground) return;
    const img = backgroundSourceImgRef.current;
    if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) return;

    const rect = img.getBoundingClientRect();
    const x = Math.min(
      img.naturalWidth - 1,
      Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * img.naturalWidth))
    );
    const y = Math.min(
      img.naturalHeight - 1,
      Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * img.naturalHeight))
    );

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    try {
      ctx.drawImage(img, 0, 0);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      const hex = `#${[r, g, b]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
      setBackgroundColor(hex);
      setAutoBackground(false);
      setIsPickingBackground(false);
    } catch (err) {
      console.error("Failed to sample background color:", err);
      setErrorMsg(t.backgroundPickFailed);
      setIsPickingBackground(false);
    }
  };

  const handleApplyBackgroundRemoval = async () => {
    if (!currentJobId) return;
    setIsApplyingBackground(true);
    setErrorMsg(null);
    try {
      await applyBackgroundRemoval(currentJobId, {
        background_color: autoBackground ? null : backgroundColor,
        threshold: backgroundThreshold,
        feather: backgroundFeather,
        block_size: backgroundBlockSize,
        edge_connected: true,
      });
    } catch (e: any) {
      setErrorMsg(e.message || t.backgroundRemovalFailed);
      setIsApplyingBackground(false);
    } finally {
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
        </div>

        {/* Configurations Form */}
        <div
          ref={settingsFormRef}
          className={`settings-form ${reviewStep === "frames" && currentJobId && frames.length > 0 ? "is-frame-selection-mode" : "is-config-mode"}`}
        >
          {reviewStep === "frames" && currentJobId && frames.length > 0 && (
            <div className="frame-selection-sidebar">
              <div className="settings-section-title panel-title-shimmer">{t.frameSelectionTitle}</div>

              <div className="selection-summary-row">
                <span>{t.totalFrames}</span>
                <strong>{frames.length}</strong>
              </div>
              <div className="selection-summary-row">
                <span>{t.selectedFrames}</span>
                <strong>{selectedFrames.length}</strong>
              </div>

              <div className="form-group">
                <TooltipLabel help={t.paramHelp.keyframeMethod}>
                  {t.keyframeAlgorithm}
                </TooltipLabel>
                <CustomSelect
                  value={keyframeMethod}
                  onChange={(val) => setKeyframeMethod(val as "adjacent" | "flow")}
                  options={[
                    { value: "adjacent", label: t.keyframeAdjacent },
                    { value: "flow", label: t.keyframeFlow },
                  ]}
                />
              </div>

              <div className="form-group">
                <TooltipLabel help={t.paramHelp.keyframeThreshold} value={<span className="slider-val">{keyframeThreshold.toFixed(1)}</span>}>
                  {t.keyframeDiffThreshold}
                </TooltipLabel>
                <div className="slider-container">
                  <input
                    type="range"
                    min="0"
                    max={keyframeMethod === "flow" ? "32" : "48"}
                    step="0.5"
                    value={keyframeThreshold}
                    onChange={(e) => setKeyframeThreshold(parseFloat(e.target.value))}
                  />
                </div>
              </div>

              <div className="selection-note">
                {t.keyframeSettingsNote}
              </div>

              <div className="form-group">
                <label>{t.selectEveryNLabel}</label>
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={selectionEveryN}
                  onChange={(e) => setSelectionEveryN(Math.max(1, parseInt(e.target.value, 10) || 1))}
                />
              </div>

              <div className="selection-actions-two">
                <button
                  type="button"
                  className="selection-secondary-btn"
                  onClick={handleSelectEveryNFrames}
                  disabled={frames.length === 0}
                >
                  {t.ruleSelectFrames}
                  <span>1/{selectionEveryN}</span>
                </button>
                <button
                  type="button"
                  className="selection-primary-btn"
                  onClick={handleAutoSelectKeyframes}
                  disabled={isAnalyzingKeyframes || frames.length < 2}
                >
                  {isAnalyzingKeyframes ? <span className="spinner" /> : <Sparkles size={14} />}
                  {isAnalyzingKeyframes ? t.analyzingKeyframes : t.autoSelectKeyframes}
                </button>
              </div>

              {selectedFrames.length > 0 && (
                <button
                  type="button"
                  className="selection-clear-btn"
                  onClick={() => {
                    setIsPlaying(false);
                    setSelectedFrames([]);
                    setLastSelectedIndex(null);
                  }}
                >
                  {t.clearCurrentSelection}
                </button>
              )}
            </div>
          )}

          {!(reviewStep === "frames" && currentJobId && frames.length > 0) && (
          <>
          <div className="settings-section-title">{t.coreAlgorithm}</div>
          
          <div className="form-group">
            <TooltipLabel help={t.paramHelp.sampleMethod} value={<span className="label-hint">sample_method</span>} className="tooltip-down">
              {t.sampleMethod}
            </TooltipLabel>
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
            <TooltipLabel help={t.paramHelp.gridDimensions} value={<span className="label-hint">grid_size</span>} className="tooltip-down">
              {t.gridDimensions}
            </TooltipLabel>
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
            <TooltipLabel help={t.paramHelp.refineIntensity} value={<span className="slider-val">{refineIntensity.toFixed(2)}</span>}>
              {t.refineIntensity}
            </TooltipLabel>
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
            <TooltipLabel help={t.paramHelp.voteFrames} value={<span className="label-hint">vote_frames</span>}>
              {t.voteFrames}
            </TooltipLabel>
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
            <TooltipLabel help={t.paramHelp.outputScale} value={<span className="slider-val">{outputScale}x</span>}>
              {t.outputUpscaleFactor}
            </TooltipLabel>
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
              <TooltipLabel help={t.paramHelp.minSize}>
                {t.minPixelSize}
              </TooltipLabel>
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
              <TooltipLabel help={t.paramHelp.peakWidth}>
                {t.peakWidth}
              </TooltipLabel>
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
            <TooltipLabel help={t.paramHelp.frameStep} value={<span className="label-hint">every_n_frames</span>}>
              {t.frameSamplingStep}
            </TooltipLabel>
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
            <TooltipLabel htmlFor="toggle-fix-square" style={{ cursor: "pointer" }} help={t.paramHelp.fixSquare}>
              {t.forceSquareAlignment}
            </TooltipLabel>
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
            <TooltipLabel htmlFor="toggle-adaptive-grid" style={{ cursor: "pointer" }} help={t.paramHelp.adaptiveGrid}>
              {t.adaptiveGrid}
            </TooltipLabel>
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
            <TooltipLabel htmlFor="toggle-temporal-smoothing" style={{ cursor: "pointer" }} help={t.paramHelp.temporalSmoothing}>
              {t.temporalSmoothing}
            </TooltipLabel>
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
            <TooltipLabel htmlFor="toggle-denoise" style={{ cursor: "pointer" }} help={t.paramHelp.denoise}>
              {t.denoise}
            </TooltipLabel>
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
                  <TooltipLabel help={t.paramHelp.gridBlend} value={<span className="slider-val">{gridBlend.toFixed(2)}</span>}>
                    {t.gridBlend}
                  </TooltipLabel>
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
                    <TooltipLabel help={t.paramHelp.temporalAlpha} value={<span className="slider-val">{temporalAlpha.toFixed(2)}</span>}>
                      {t.temporalAlpha}
                    </TooltipLabel>
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
                    <TooltipLabel help={t.paramHelp.sceneThreshold} value={<span className="slider-val">{sceneChangeThreshold.toFixed(0)}</span>}>
                      {t.sceneChangeThreshold}
                    </TooltipLabel>
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
                  <TooltipLabel help={t.paramHelp.denoiseStrength} value={<span className="slider-val">{denoiseStrength.toFixed(1)}</span>}>
                    {t.denoiseStrength}
                  </TooltipLabel>
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

          </>
          )}
        </div>

        {/* Action Button inside Sidebar (Fixed at bottom) */}
        {file && !(reviewStep === "frames" && currentJobId && frames.length > 0) && (
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
          {currentJobId && jobStatus && jobStatus.status !== "done" && jobStatus.status !== "error" && jobStatus.stage !== "background_removal" && (
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

          {/* STATE 3.5: BACKGROUND REMOVAL POST-PROCESSING */}
          {currentJobId && jobStatus && reviewStep === "background" && frames.length > 0 && (jobStatus.status === "done" || jobStatus.stage === "background_removal") && (
            <div className="background-panel">
              <div className="viewer-header">
                <button className="back-home-btn" onClick={handleGoBack}>
                  <ArrowLeft size={14} />
                  {t.backUploadNew}
                </button>
                <div className="viewer-title">
                  <h2>{t.backgroundPanelTitle}</h2>
                  <span className="process-job-id">{t.backgroundPanelSubtitle}</span>
                </div>
                <div className="status-badge done">
                  <Eraser size={12} />
                  {t.postProcess}
                </div>
              </div>

              <div className="background-layout">
                <div className="background-preview-grid">
                  <div className="background-preview-column">
                    <span className="info-title">{t.originalFrame}</span>
                    <div className="player-viewport background-preview">
                      <img
                        ref={backgroundSourceImgRef}
                        crossOrigin="anonymous"
                        src={getFrameUrl(currentJobId, frames[currentFrameIndex].name)}
                        alt="Original processed frame"
                        className={`player-frame-img ${isPickingBackground ? "is-picking-color" : ""}`}
                        onClick={handlePickBackgroundColor}
                      />
                      {isPickingBackground && (
                        <div className="viewport-overlay">{t.pickBackgroundHint}</div>
                      )}
                    </div>
                  </div>
                  <div className="background-preview-column">
                    <span className="info-title">{t.backgroundPreview}</span>
                    <div className="player-viewport background-preview">
                      <img
                        src={getBackgroundPreviewUrl(
                          currentJobId,
                          frames[currentFrameIndex].name,
                          autoBackground ? null : backgroundColor,
                          backgroundThreshold,
                          backgroundFeather,
                          backgroundBlockSize,
                          true
                        )}
                        alt="Background removal preview"
                        className="player-frame-img"
                      />
                    </div>
                  </div>
                </div>

                <div className="background-controls">
                  <div className="form-group">
                    <TooltipLabel
                      help={t.paramHelp.backgroundColor}
                      value={
                        <span className="label-hint">
                          {autoBackground ? t.backgroundAuto : backgroundColor}
                        </span>
                      }
                      className="tooltip-down"
                    >
                      {t.backgroundColor}
                    </TooltipLabel>
                    <label className="auto-bg-toggle">
                      <input
                        type="checkbox"
                        checked={autoBackground}
                        onChange={(e) => setAutoBackground(e.target.checked)}
                        disabled={isApplyingBackground}
                      />
                      {t.backgroundAutoDetect}
                    </label>
                    <button
                      type="button"
                      className={`eyedropper-btn ${isPickingBackground ? "active" : ""}`}
                      onClick={() => {
                        setAutoBackground(false);
                        setIsPickingBackground((prev) => !prev);
                      }}
                      disabled={isApplyingBackground}
                    >
                      <Pipette size={14} />
                      {t.pickBackgroundColor}
                    </button>
                    <div className="color-control-row" style={autoBackground ? { opacity: 0.4, pointerEvents: "none" } : undefined}>
                      <input
                        type="color"
                        value={backgroundColor}
                        onChange={(e) => setBackgroundColor(e.target.value)}
                        disabled={isApplyingBackground || autoBackground}
                      />
                      <input
                        type="text"
                        value={backgroundColor}
                        onChange={(e) => setBackgroundColor(e.target.value)}
                        disabled={isApplyingBackground || autoBackground}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <TooltipLabel help={t.paramHelp.backgroundThreshold} value={<span className="slider-val">{backgroundThreshold.toFixed(0)}</span>}>
                      {t.backgroundThreshold}
                    </TooltipLabel>
                    <div className="slider-container">
                      <input
                        type="range"
                        min="0"
                        max="120"
                        step="2"
                        value={backgroundThreshold}
                        onChange={(e) => setBackgroundThreshold(parseFloat(e.target.value))}
                        disabled={isApplyingBackground}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <TooltipLabel help={t.paramHelp.backgroundFeather} value={<span className="slider-val">{backgroundFeather}px</span>}>
                      {t.backgroundFeather}
                    </TooltipLabel>
                    <div className="slider-container">
                      <input
                        type="range"
                        min="0"
                        max="8"
                        step="1"
                        value={backgroundFeather}
                        onChange={(e) => setBackgroundFeather(parseInt(e.target.value, 10))}
                        disabled={isApplyingBackground}
                      />
                    </div>
                  </div>

                  <div className="background-mask-info">
                    <span>{t.backgroundBlockUnit}</span>
                    <strong>{backgroundBlockSize} × {backgroundBlockSize}</strong>
                    <span>{t.backgroundEdgeLocked}</span>
                  </div>

                  <div className="scrubber-container">
                    <input
                      type="range"
                      min={0}
                      max={frames.length - 1}
                      value={currentFrameIndex}
                      onChange={(e) => setCurrentFrameIndex(parseInt(e.target.value, 10))}
                      disabled={isApplyingBackground}
                    />
                    <span className="current-time-badge">{currentFrameIndex + 1} / {frames.length}</span>
                  </div>

                  <div className="background-actions">
                    <button className="cancel-btn" onClick={handleSkipBackground} disabled={isApplyingBackground}>
                      {t.skipBackground}
                    </button>
                    <button className="submit-btn" onClick={handleApplyBackgroundRemoval} disabled={isApplyingBackground}>
                      {isApplyingBackground ? (
                        <>
                          <span className="spinner" />
                          {t.applyingBackground}
                        </>
                      ) : (
                        <>
                          <Eraser size={18} />
                          {t.applyBackgroundAll}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STATE 4: PLAYBACK / REVIEW */}
          {currentJobId && jobStatus && reviewStep === "frames" && (jobStatus.status === "done" || (jobStatus.status === "error" && frames.length > 0)) && (
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
                          {t.frameText}{" "}
                          {hasSelection && playbackPos !== -1
                            ? `${playbackPos + 1} / ${playbackCount}`
                            : `${frames[currentFrameIndex].index} / ${frames.length - 1}`}
                        </div>
                      </div>

                      <div className="player-controls-row">
                        {/* Seek Slider */}
                        <div className="scrubber-container">
                          <input
                            type="range"
                            min={0}
                            max={hasSelection ? sortedSelectedFrames.length - 1 : frames.length - 1}
                            value={playbackPos === -1 ? 0 : playbackPos}
                            onChange={(e) => {
                              setIsPlaying(false);
                              const pos = Math.min(
                                playbackFrameIndices.length - 1,
                                Math.max(0, parseInt(e.target.value, 10))
                              );
                              const idx = playbackFrameIndices[pos];
                              if (idx !== undefined) setCurrentFrameIndex(idx);
                            }}
                          />
                          <span className="current-time-badge">
                            {hasSelection && playbackPos !== -1
                              ? `${playbackPos + 1} / ${playbackCount}`
                              : `${currentFrameIndex + 1} / ${frames.length}`}
                          </span>
                        </div>

                        {/* Control buttons */}
                        <div className="player-button-group">
                          <button 
                            className="btn-ctrl" 
                            onClick={() => jumpPlaybackTo("first")}
                            title={t.firstFrame}
                          >
                            <SkipBack size={16} />
                          </button>

                          <button 
                            className="btn-ctrl" 
                            onClick={() => stepPlaybackBy(-1)}
                            title={t.previousFrame}
                          >
                            <StepBack size={16} />
                          </button>

                          <button 
                            className="btn-ctrl play-pause" 
                            onClick={() => setIsPlaying(!isPlaying)}
                            title={isPlaying ? t.pause : t.play}
                          >
                            {isPlaying ? <Pause size={20} /> : <Play size={20} style={{ transform: "translateX(1px)" }} />}
                          </button>

                          <button 
                            className="btn-ctrl" 
                            onClick={() => stepPlaybackBy(1)}
                            title={t.nextFrame}
                          >
                            <StepForward size={16} />
                          </button>

                          <button 
                            className="btn-ctrl" 
                            onClick={() => jumpPlaybackTo("last")}
                            title={t.lastFrame}
                          >
                            <SkipForward size={16} />
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
                      </div>

                      {/* Export / Download actions (moved under info panel) */}
                      <div className="sidebar-action-card" style={{ flexDirection: "row" }}>
                        <button
                          className="export-btn"
                          style={{ background: "var(--accent-green)", color: "#121212", flex: 1 }}
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
                          style={{ textDecoration: "none", color: "inherit", flex: 1 }}
                        >
                          <button className="export-btn" style={{ background: "transparent", color: "#fff", border: "1px solid var(--border-color)", width: "100%" }}>
                            <Download size={16} />
                            {t.downloadFrame}
                          </button>
                        </a>
                      </div>
                    </>
                  ) : (
                    <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                      {t.noFramesRender}
                    </div>
                  )}
                </div>

                <div className="player-sidebar">
                  <div className="thumbnails-container">
                    <div className="thumbnails-header">
                      <span className="info-title">{t.frameListPng}</span>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                        {t.selectedCount(selectedFrames.length)}
                      </span>
                    </div>
                    <div
                      ref={thumbnailsContainerRef}
                      className="thumbnails-grid"
                    >
                      {frames.map((frame) => {
                        const isSelected = selectedFrameSet.has(frame.index);
                        return (
                          <div 
                            key={frame.name}
                            className={`thumbnail-card ${frame.index === currentFrameIndex ? "active" : ""} ${isSelected ? "selected" : ""}`}
                            style={{
                              cursor: "pointer",
                            }}
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
                                setCurrentFrameIndex(frame.index);
                              }
                              
                              setLastSelectedIndex(frame.index);
                            }}
                          >
                            <img src={getFrameUrl(currentJobId, frame.name)} alt="" loading="lazy" />
                            {frame.is_keyframe && <span className="thumb-keyframe">{t.keyframeBadge}</span>}
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
