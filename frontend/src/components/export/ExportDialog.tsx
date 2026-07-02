import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  X,
  FolderOpen,
  CheckCircle2,
  AlertTriangle,
  FileDown,
  Loader2,
  Sparkles,
  Image as ImageIcon,
  Film
} from "lucide-react";
import {
  createExport,
  getExportStatus,
  getJobMetadata,
  getFrameUrl,
  ExportFormat,
  ExportFrameSelection,
  ExportSizeOptions,
  CreateExportRequest,
  FrameInfo
} from "../../api";
import "./ExportDialog.css";

interface ExportDialogProps {
  jobId: string;
  frames: FrameInfo[];
  currentFrameIndex: number;
  selectedFrames?: number[];
  onClose: () => void;
  t: any; // Translation strings
  lang: string;
}

interface MetadataState {
  width: number;
  height: number;
  originalFps: number;
  processedFps: number;
  frameCount: number;
  loaded: boolean;
}

type SpriteGridPreset = "4x4" | "8x4" | "8x8" | "16x8" | "16x16" | "custom";

const SPRITE_GRID_PRESETS: Array<{
  value: SpriteGridPreset;
  label: string;
  columns: number;
  rows: number;
}> = [
  { value: "4x4", label: "4 × 4", columns: 4, rows: 4 },
  { value: "8x4", label: "8 × 4", columns: 8, rows: 4 },
  { value: "8x8", label: "8 × 8", columns: 8, rows: 8 },
  { value: "16x8", label: "16 × 8", columns: 16, rows: 8 },
  { value: "16x16", label: "16 × 16", columns: 16, rows: 16 },
];

const clampSpriteGridValue = (value: number) => {
  return Math.max(1, Math.min(64, Math.floor(value) || 1));
};

export function ExportDialog({
  jobId,
  frames,
  currentFrameIndex,
  selectedFrames = [],
  onClose,
  t,
  lang
}: ExportDialogProps) {
  const isTauri = "__TAURI_INTERNALS__" in window;

  // Tabs / Formats
  const [format, setFormat] = useState<ExportFormat>("png_sequence");
  const isSpriteSheet = format === "sprite_sheet" || format === "sprite_sheet_4x4";

  // Output Path
  const [outputPath, setOutputPath] = useState<string>("");

  // Naming (PNG sequence only)
  const [filenameTemplate, setFilenameTemplate] = useState<string>("{project}_{index:04}");
  const [indexStart, setIndexStart] = useState<number>(0);
  const [overwrite, setOverwrite] = useState<boolean>(false);

  // GIF specific
  const [fps, setFps] = useState<number>(12);
  const [loop, setLoop] = useState<boolean>(true);

  // Frame Range selection
  const [rangeMode, setRangeMode] = useState<"all" | "current" | "range" | "indices">(() => {
    return selectedFrames.length > 0 ? "indices" : "all";
  });
  const [startFrame, setStartFrame] = useState<number>(0);
  const [endFrame, setEndFrame] = useState<number>(frames.length - 1);
  const [everyNFrames, setEveryNFrames] = useState<number>(1);
  const [targetFps, setTargetFps] = useState<string>("");
  const [maxFrames, setMaxFrames] = useState<string>("");
  const [selectedIndices] = useState<number[]>(() => {
    return selectedFrames.length > 0 ? [...selectedFrames].sort((a, b) => a - b) : [];
  });

  // Sprite Sheet details
  const [insufficientFrames, setInsufficientFrames] = useState<"repeat_last" | "transparent" | "error">("repeat_last");
  const [spritePreset, setSpritePreset] = useState<SpriteGridPreset>("4x4");
  const [spriteColumns, setSpriteColumns] = useState<number>(4);
  const [spriteRows, setSpriteRows] = useState<number>(4);

  // Size Options
  const [sizeMode, setSizeMode] = useState<"source" | "scale" | "custom">("source");
  const [scale, setScale] = useState<number>(1);
  const [customWidth, setCustomWidth] = useState<number>(128);
  const [customHeight, setCustomHeight] = useState<number>(128);
  const [keepAspect, setKeepAspect] = useState<boolean>(true);
  const [fitMode, setFitMode] = useState<"exact" | "fit">("exact");
  const [backgroundColor, setBackgroundColor] = useState<string>("#00000000");

  // Job metadata
  const [metadata, setMetadata] = useState<MetadataState>({
    width: 128,
    height: 128,
    originalFps: 30,
    processedFps: 15,
    frameCount: frames.length,
    loaded: false
  });

  const [stage, setStage] = useState<"idle" | "validating" | "exporting" | "done" | "error">("idle");
  const [progress, setProgress] = useState<number>(0);
  const [writtenFiles, setWrittenFiles] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  // Path warnings
  const [pathWarning, setPathWarning] = useState<string | null>(null);
  const spriteCellCount = spriteColumns * spriteRows;
  const sourceFrameCount = metadata.originalFps > 0 ? metadata.frameCount : frames.length;
  const selectedSequenceIndices = useMemo(() => {
    return selectedIndices.length > 0
      ? selectedIndices.filter((idx) => frames.some((frame) => frame.index === idx))
      : frames.map((frame) => frame.index);
  }, [selectedIndices, frames]);
  const selectedSequenceCount = selectedSequenceIndices.length;
  const spriteOverflowCount = Math.max(0, selectedSequenceCount - spriteCellCount);
  const spriteOverflowWarning = isSpriteSheet && spriteOverflowCount > 0
    ? t.spriteOverflowWarning(selectedSequenceCount, spriteCellCount, spriteOverflowCount)
    : null;

  const applySpritePreset = (preset: SpriteGridPreset) => {
    setSpritePreset(preset);
    const config = SPRITE_GRID_PRESETS.find((item) => item.value === preset);
    if (config) {
      setSpriteColumns(config.columns);
      setSpriteRows(config.rows);
    }
  };

  // Resolve unique path to avoid overwrite
  const checkAndResolvePath = async (path: string) => {
    if (!isTauri || !path.trim() || format === "png_sequence") {
      setPathWarning(null);
      return;
    }
    try {
      const resolved = await invoke<string>("resolve_unique_path", { path: path.trim() });
      if (resolved !== path.trim()) {
        setOutputPath(resolved);
        setPathWarning(`${t.pathExistsWarning}${resolved}`);
      } else {
        setPathWarning(null);
      }
    } catch (err) {
      console.error("Resolve path error:", err);
      setPathWarning(null);
    }
  };

  // Load metadata on mount
  useEffect(() => {
    const loadMetadata = async () => {
      try {
        const meta = await getJobMetadata(jobId);
        setMetadata({
          width: meta.frame_width || 128,
          height: meta.frame_height || 128,
          originalFps: meta.source_fps || 30,
          processedFps: meta.processed_fps || 15,
          frameCount: meta.processed_frame_count || frames.length,
          loaded: true
        });
        setCustomWidth(meta.frame_width || 128);
        setCustomHeight(meta.frame_height || 128);
      } catch (err) {
        // Fallback: load first frame image in background to read natural dimensions
        if (frames.length > 0) {
          const img = new Image();
          img.onload = () => {
            setMetadata({
              width: img.naturalWidth,
              height: img.naturalHeight,
              originalFps: 30,
              processedFps: 15,
              frameCount: frames.length,
              loaded: true
            });
            setCustomWidth(img.naturalWidth);
            setCustomHeight(img.naturalHeight);
          };
          img.onerror = () => {
            setMetadata({
              width: 128,
              height: 128,
              originalFps: 30,
              processedFps: 15,
              frameCount: frames.length,
              loaded: true
            });
          };
          img.src = getFrameUrl(jobId, frames[0].name);
        }
      }
    };
    loadMetadata();
  }, [jobId, frames]);

  // Clean polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Update default output path based on format when path is empty
  useEffect(() => {
    if (!outputPath && isTauri) {
      // Set reasonable default names based on format
      if (format === "png_sequence") {
        setOutputPath("output/pixel_sequence");
      } else if (format === "gif") {
        setOutputPath("output/pixel_export.gif");
      } else if (isSpriteSheet) {
        setOutputPath("output/pixel_sheet.png");
      } else {
        setOutputPath("output/pixel_frame.png");
      }
    }
  }, [format, isSpriteSheet, outputPath, isTauri]);

  // Sync aspect ratio when custom width/height changes
  const handleWidthChange = (val: number) => {
    setCustomWidth(val);
    if (keepAspect && metadata.width > 0) {
      const ratio = metadata.height / metadata.width;
      setCustomHeight(Math.round(val * ratio));
    }
  };

  const handleHeightChange = (val: number) => {
    setCustomHeight(val);
    if (keepAspect && metadata.height > 0) {
      const ratio = metadata.width / metadata.height;
      setCustomWidth(Math.round(val * ratio));
    }
  };

  // Open directory/file dialog
  const handleBrowsePath = async () => {
    try {
      if (format === "png_sequence") {
        const selected = await openDialog({
          directory: true,
          multiple: false,
          title: t.selectFolderTitle
        });
        if (selected) {
          const path = typeof selected === "string" ? selected : selected[0];
          setOutputPath(path);
          await checkAndResolvePath(path);
        }
      } else {
        const ext = format === "gif" ? "gif" : "png";
        const filterName = format === "gif" ? "GIF" : "PNG";
        const selected = await saveDialog({
          title: t.selectFileTitle,
          filters: [{ name: filterName, extensions: [ext] }]
        });
        if (selected) {
          setOutputPath(selected);
          await checkAndResolvePath(selected);
        }
      }
    } catch (err) {
      console.error("Tauri dialog error:", err);
    }
  };

  // Naming template validation
  const namingValidationError = useMemo(() => {
    if (format !== "png_sequence") return null;
    if (!filenameTemplate.trim()) return t.templateValidationErr;
    
    // Validate containing at least {index}, {index:NN}, or {source_index}
    const hasIndex = /\{index(:\d+)?\}/.test(filenameTemplate) || filenameTemplate.includes("{source_index}");
    if (!hasIndex) {
      return t.templateValidationErr;
    }

    // Validate path separators or illegal characters
    const hasIllegalChars = /[\/\\:?*\"<>|]/.test(filenameTemplate);
    if (hasIllegalChars) {
      return t.invalidCharsErr;
    }

    return null;
  }, [filenameTemplate, format, t]);

  // Frame Range List calculation
  const selectedFrameCount = useMemo(() => {
    if (format === "single_png") return 1;
    if (isSpriteSheet) return Math.min(selectedSequenceCount, spriteCellCount);

    let baseCount = 0;
    if (rangeMode === "all") {
      baseCount = metadata.frameCount;
    } else if (rangeMode === "current") {
      baseCount = 1;
    } else if (rangeMode === "range") {
      const s = Math.max(0, Math.min(startFrame, frames.length - 1));
      const e = Math.max(0, Math.min(endFrame, frames.length - 1));
      baseCount = Math.max(1, Math.abs(e - s) + 1);
    } else if (rangeMode === "indices") {
      baseCount = selectedIndices.length;
    }

    let count = Math.ceil(baseCount / everyNFrames);
    
    // Apply max limits
    const limit = parseInt(maxFrames, 10);
    if (!isNaN(limit) && limit > 0) {
      count = Math.min(count, limit);
    }

    return count;
  }, [format, isSpriteSheet, spriteCellCount, selectedSequenceCount, rangeMode, startFrame, endFrame, everyNFrames, maxFrames, selectedIndices, metadata.frameCount, frames]);

  // Estimate single frame dimensions based on size settings
  const estimatedFrameDimensions = useMemo(() => {
    if (sizeMode === "source") {
      return { w: metadata.width, h: metadata.height };
    } else if (sizeMode === "scale") {
      return { w: metadata.width * scale, h: metadata.height * scale };
    } else {
      return { w: customWidth, h: customHeight };
    }
  }, [sizeMode, scale, customWidth, customHeight, metadata]);

  // Total size estimation
  const totalOutputDimensions = useMemo(() => {
    const frame = estimatedFrameDimensions;
    if (isSpriteSheet) {
      return { w: frame.w * spriteColumns, h: frame.h * spriteRows };
    }
    return frame;
  }, [isSpriteSheet, estimatedFrameDimensions, spriteColumns, spriteRows]);

  // Sprite Sheet Preview Indices
  const spritePreviewIndices = useMemo(() => {
    if (!isSpriteSheet) return [];
    const frameByIndex = new Map(frames.map((frame, position) => [frame.index, position]));
    const selectedPreview = selectedSequenceIndices
      .slice(0, spriteCellCount)
      .map((idx) => frameByIndex.get(idx) ?? -1);
    while (selectedPreview.length < spriteCellCount) {
      selectedPreview.push(-1);
    }
    return selectedPreview;
  }, [isSpriteSheet, frames, selectedSequenceIndices, spriteCellCount]);

  // Poll export progress
  const startStatusPolling = (jobId: string, expId: string) => {
    setStage("exporting");
    setProgress(0);

    pollIntervalRef.current = window.setInterval(async () => {
      try {
        const res = await getExportStatus(jobId, expId);
        setProgress(res.progress);
        setWrittenFiles(res.written_files || []);

        if (res.status === "done") {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setStage("done");
        } else if (res.status === "error") {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setStage("error");
          setErrorMessage(res.error || t.processingError);
        }
      } catch (err: any) {
        console.error("Polling export task error: ", err);
      }
    }, 400);
  };

  // Submit export request
  const handleStartExport = async () => {
    if (!outputPath.trim()) {
      setErrorMessage(t.pathPlaceholder);
      setStage("error");
      return;
    }

    let finalPath = outputPath.trim();
    if (isTauri && format !== "png_sequence") {
      try {
        const resolved = await invoke<string>("resolve_unique_path", { path: finalPath });
        if (resolved !== finalPath) {
          setOutputPath(resolved);
          setPathWarning(`${t.pathExistsWarning}${resolved}`);
          finalPath = resolved;
        }
      } catch (err) {
        console.error("Resolve path on submit error:", err);
      }
    }

    if (namingValidationError) {
      setErrorMessage(namingValidationError);
      setStage("error");
      return;
    }

    if (spriteOverflowWarning) {
      setErrorMessage(spriteOverflowWarning);
      setStage("error");
      return;
    }

    setStage("validating");
    setErrorMessage(null);

    let frame_selection: ExportFrameSelection;

    if (isSpriteSheet) {
      frame_selection = {
        mode: "indices",
        indices: selectedSequenceIndices
      };
    } else {
      frame_selection = {
        mode: rangeMode,
        every_n_frames: everyNFrames
      };

      if (rangeMode === "range") {
        frame_selection.start = startFrame;
        frame_selection.end = endFrame;
      } else if (rangeMode === "indices") {
        frame_selection.indices = [...selectedIndices].sort((a, b) => a - b);
      } else if (rangeMode === "current") {
        frame_selection.start = currentFrameIndex;
      }

      if (maxFrames.trim()) {
        const limit = parseInt(maxFrames, 10);
        if (!isNaN(limit)) frame_selection.max_frames = limit;
      }

      if (targetFps.trim()) {
        const target = parseFloat(targetFps);
        if (!isNaN(target)) frame_selection.target_fps = target;
      }
    }

    // Sizing building
    const size: ExportSizeOptions = {
      mode: sizeMode
    };

    if (sizeMode === "scale") {
      size.scale = scale;
    } else if (sizeMode === "custom") {
      size.width = customWidth;
      size.height = customHeight;
      size.keep_aspect = keepAspect;
      size.fit = fitMode;
      size.background = backgroundColor;
    }

    // Request building
    const request: CreateExportRequest = {
      format,
      output_path: finalPath,
      overwrite,
      frame_selection,
      size
    };

    if (format === "png_sequence") {
      request.filename_template = filenameTemplate;
      request.index_start = indexStart;
    } else if (format === "gif") {
      request.fps = fps;
      request.loop = loop;
    } else if (isSpriteSheet) {
      request.sprite_pad = insufficientFrames;
      request.sprite_columns = spriteColumns;
      request.sprite_rows = spriteRows;
    }

    try {
      const res = await createExport(jobId, request);
      startStatusPolling(jobId, res.export_id);
    } catch (err: any) {
      setStage("error");
      setErrorMessage(err.message || t.processingError);
    }
  };

  // Open directory / show file
  const handleOpenLocation = async () => {
    if (!isTauri) return;
    try {
      await invoke("open_path_in_finder", { path: outputPath });
    } catch (err) {
      console.error("Open path error:", err);
    }
  };

  const handleReset = () => {
    setStage("idle");
    setProgress(0);
    setErrorMessage(null);
  };

  // If exporting, show the full screen progress dashboard
  if (stage !== "idle" && stage !== "error") {
    return (
      <div className="export-overlay">
        <div className="export-modal" style={{ maxWidth: "460px" }}>
          <div className="export-progress-screen">
            {stage === "validating" && (
              <>
                <Loader2 size={36} className="export-spinner" style={{ animation: "spinner-spin 1.2s linear infinite" }} />
                <div className="export-progress-status-title">Validating Parameters</div>
                <div className="export-progress-status-desc">Checking paths and file conflicts on backend...</div>
              </>
            )}

            {stage === "exporting" && (
              <>
                <div className="export-spinner" />
                <div className="export-progress-percent">{Math.round(progress * 100)}%</div>
                <div className="export-progress-bar-container">
                  <div className="export-progress-bar-fill" style={{ width: `${progress * 100}%` }}>
                    <div className="export-progress-bar-shine" />
                  </div>
                </div>
                <div className="export-progress-status-title">{t.exportingStatus}</div>
                <div className="export-progress-status-desc">
                  {t.exportingMsg}
                  {writtenFiles.length > 0 && (
                    <div style={{ marginTop: "12px", fontSize: "11px", color: "var(--text-muted)", maxHeight: "40px", overflow: "hidden" }}>
                      Writing: {writtenFiles[writtenFiles.length - 1]}
                    </div>
                  )}
                </div>
              </>
            )}

            {stage === "done" && (
              <>
                <div className="export-icon-success">
                  <CheckCircle2 size={32} />
                </div>
                <div className="export-progress-status-title">{t.exportStatusDone}</div>
                <div className="export-progress-status-desc" style={{ wordBreak: "break-all" }}>
                  {outputPath}
                </div>

                <div style={{ display: "flex", gap: "12px", marginTop: "10px", width: "100%" }}>
                  {isTauri && (
                    <button className="export-action-btn" onClick={handleOpenLocation} style={{ flex: 1, justifyContent: "center" }}>
                      <FolderOpen size={16} />
                      {format === "png_sequence" ? t.openFolderBtn : t.openFileBtn}
                    </button>
                  )}
                  <button className="export-cancel-btn" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>
                    {t.exportCloseBtn}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="export-overlay">
      <div className="export-modal">
        {/* HEADER */}
        <div className="export-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <FileDown size={20} style={{ color: "var(--accent, #6366f1)" }} />
            <h3>{t.exportModalTitle}</h3>
          </div>
          <button className="export-close-x" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* CONTENT */}
        <div className="export-content">
          {/* Format selection */}
          <div className="export-form-group">
            <label>{t.exportFormatLabel}</label>
            <div className="export-tabs">
              <button
                className={`export-tab-btn ${format === "png_sequence" ? "active" : ""}`}
                onClick={() => {
                  setFormat("png_sequence");
                  setOutputPath(isTauri ? "output/pixel_sequence" : "");
                }}
              >
                <Film size={16} />
                <span>{t.pngSequenceTab}</span>
              </button>
              <button
                className={`export-tab-btn ${format === "gif" ? "active" : ""}`}
                onClick={() => {
                  setFormat("gif");
                  setOutputPath(isTauri ? "output/pixel_export.gif" : "");
                }}
              >
                <Film size={16} />
                <span>{t.gifTab}</span>
              </button>
              <button
                className={`export-tab-btn ${isSpriteSheet ? "active" : ""}`}
                onClick={() => {
                  setFormat("sprite_sheet");
                  setOutputPath(isTauri ? "output/pixel_sheet.png" : "");
                }}
              >
                <ImageIcon size={16} />
                <span>{t.spriteSheetTab}</span>
              </button>
              <button
                className={`export-tab-btn ${format === "single_png" ? "active" : ""}`}
                onClick={() => {
                  setFormat("single_png");
                  setOutputPath(isTauri ? "output/pixel_frame.png" : "");
                }}
              >
                <ImageIcon size={16} />
                <span>{t.singlePngTab}</span>
              </button>
            </div>
          </div>

          {/* Error banner from validation / failed attempts */}
          {errorMessage && (
            <div className="export-validation-msg">
              <AlertTriangle size={16} />
              <span>{errorMessage}</span>
              {stage === "error" && (
                <button
                  onClick={handleReset}
                  style={{
                    marginLeft: "auto",
                    background: "transparent",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                    textDecoration: "underline",
                    fontSize: "11px"
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          )}

          {pathWarning && (
            <div className="export-validation-msg" style={{ background: "rgba(251, 191, 36, 0.1)", borderColor: "rgba(251, 191, 36, 0.2)", color: "#fbbf24" }}>
              <AlertTriangle size={16} />
              <span>{pathWarning}</span>
              <button
                onClick={() => setPathWarning(null)}
                style={{
                  marginLeft: "auto",
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: "bold"
                }}
              >
                &times;
              </button>
            </div>
          )}

          {spriteOverflowWarning && stage !== "error" && (
            <div className="export-validation-msg" style={{ background: "rgba(251, 191, 36, 0.1)", borderColor: "rgba(251, 191, 36, 0.2)", color: "#fbbf24" }}>
              <AlertTriangle size={16} />
              <span>{spriteOverflowWarning}</span>
            </div>
          )}

          {/* Output Path Pickers */}
          <div className="export-form-group">
            <label>{t.outputPathLabel}</label>
            <div className="export-path-row">
              <input
                type="text"
                className="export-path-input"
                placeholder={format === "png_sequence" ? "Select folder path..." : "Select output file path..."}
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                onBlur={() => checkAndResolvePath(outputPath)}
              />
              {isTauri && (
                <button className="export-browse-btn" onClick={handleBrowsePath}>
                  {t.browseBtn}
                </button>
              )}
            </div>
          </div>

          {/* Form fields based on tab type */}
          {format === "png_sequence" && (
            <div className="export-options-grid">
              <div className="export-form-group export-naming-template-container">
                <label>{t.namingTemplateLabel}</label>
                <input
                  type="text"
                  className="export-path-input"
                  value={filenameTemplate}
                  onChange={(e) => setFilenameTemplate(e.target.value)}
                />
                <span className="export-template-hint">{t.namingTemplateHint}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="export-form-group">
                  <label>{t.indexStartLabel}</label>
                  <input
                    type="number"
                    className="export-path-input"
                    value={indexStart}
                    onChange={(e) => setIndexStart(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    min="0"
                  />
                </div>
                <label className="export-checkbox-row">
                  <input
                    type="checkbox"
                    checked={overwrite}
                    onChange={(e) => setOverwrite(e.target.checked)}
                  />
                  <span>{t.overwriteLabel}</span>
                </label>
              </div>
            </div>
          )}

          {format === "gif" && (
            <div className="export-options-grid">
              <div className="export-form-group">
                <label>{t.targetFpsLabel}</label>
                <input
                  type="number"
                  className="export-path-input"
                  value={fps}
                  onChange={(e) => setFps(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  min="1"
                  max="60"
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, justifyContent: "center" }}>
                <label className="export-checkbox-row">
                  <input
                    type="checkbox"
                    checked={loop}
                    onChange={(e) => setLoop(e.target.checked)}
                  />
                  <span>Loop Animation</span>
                </label>
                <label className="export-checkbox-row">
                  <input
                    type="checkbox"
                    checked={overwrite}
                    onChange={(e) => setOverwrite(e.target.checked)}
                  />
                  <span>{t.overwriteLabel}</span>
                </label>
              </div>
            </div>
          )}

          {(isSpriteSheet || format === "single_png") && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <label className="export-checkbox-row">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                />
                <span>{t.overwriteLabel}</span>
              </label>
            </div>
          )}

          {/* Frame Range Section */}
          {format !== "single_png" && !isSpriteSheet && (
            <div className="export-form-group">
              <div className="export-section-title">{t.frameRangeLabel}</div>
              <div className="export-inputs-row">
                <div className="export-form-group">
                  <label>Mode</label>
                  <select
                    className="export-select-styled"
                    value={rangeMode}
                    onChange={(e) => setRangeMode(e.target.value as any)}
                  >
                    <option value="all">{t.rangeAll}</option>
                    <option value="current">{t.rangeCurrent}</option>
                    <option value="range">{t.rangeCustom}</option>
                    <option value="indices">{t.rangeIndices}</option>
                  </select>
                </div>
                <div className="export-form-group">
                  <label>{t.frameStepLabel}</label>
                  <input
                    type="number"
                    className="export-path-input"
                    value={everyNFrames}
                    onChange={(e) => setEveryNFrames(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    min="1"
                  />
                </div>
              </div>

              {rangeMode === "range" && (
                <div className="export-inputs-row" style={{ marginTop: "8px" }}>
                  <div className="export-form-group">
                    <label>{t.startFrameLabel}</label>
                    <input
                      type="number"
                      className="export-path-input"
                      value={startFrame}
                      onChange={(e) => setStartFrame(Math.max(0, Math.min(frames.length - 1, parseInt(e.target.value, 10) || 0)))}
                      min="0"
                      max={frames.length - 1}
                    />
                  </div>
                  <div className="export-form-group">
                    <label>{t.endFrameLabel}</label>
                    <input
                      type="number"
                      className="export-path-input"
                      value={endFrame}
                      onChange={(e) => setEndFrame(Math.max(0, Math.min(frames.length - 1, parseInt(e.target.value, 10) || 0)))}
                      min="0"
                      max={frames.length - 1}
                    />
                  </div>
                </div>
              )}

              {rangeMode === "indices" && (
                <div className="export-form-group" style={{ marginTop: "8px" }}>
                  <div className="export-summary-box" style={{ background: "rgba(30, 215, 96, 0.05)", border: "1px dashed rgba(30, 215, 96, 0.2)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--accent-green)" }}>
                      <CheckCircle2 size={16} />
                      <span style={{ fontSize: "13px", fontWeight: "500", color: "#fff" }}>
                        {selectedIndices.length === 0 
                          ? (lang === "zh" ? "未选择任何帧，请先在侧边栏中选择要导出的帧。" : "No frames selected. Please select frames in the editor sidebar first.")
                          : (lang === "zh" ? `将只导出在侧边栏已选择的 ${selectedIndices.length} 帧。` : `Will export the ${selectedIndices.length} frames selected in the editor sidebar.`)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div className="export-inputs-row" style={{ marginTop: "8px" }}>
                <div className="export-form-group">
                  <label>{t.targetFpsLabel} (Optional)</label>
                  <input
                    type="number"
                    className="export-path-input"
                    placeholder="e.g. 12"
                    value={targetFps}
                    onChange={(e) => setTargetFps(e.target.value)}
                  />
                </div>
                <div className="export-form-group">
                  <label>{t.maxFramesLabel} (Optional)</label>
                  <input
                    type="number"
                    className="export-path-input"
                    placeholder="e.g. 60"
                    value={maxFrames}
                    onChange={(e) => setMaxFrames(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Sprite Sheet Options */}
          {isSpriteSheet && (
            <div className="export-form-group">
              <div className="export-summary-box" style={{ background: "rgba(30, 215, 96, 0.05)", border: "1px dashed rgba(30, 215, 96, 0.2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--accent-green)" }}>
                  <CheckCircle2 size={16} />
                  <span style={{ fontSize: "13px", fontWeight: "500", color: "#fff" }}>
                    {t.spriteSourceSelectionInfo(sourceFrameCount, selectedSequenceCount)}
                  </span>
                </div>
              </div>

              <div className="export-section-title">{t.spriteGridLabel}</div>
              <div className="export-inputs-row">
                <div className="export-form-group">
                  <label>{t.spritePresetLabel}</label>
                  <select
                    className="export-select-styled"
                    value={spritePreset}
                    onChange={(e) => applySpritePreset(e.target.value as SpriteGridPreset)}
                  >
                    {SPRITE_GRID_PRESETS.map((preset) => (
                      <option key={preset.value} value={preset.value}>{preset.label}</option>
                    ))}
                    <option value="custom">{t.spriteCustomGrid}</option>
                  </select>
                </div>
                <div className="export-form-group">
                  <label>{t.spriteCellsLabel}</label>
                  <input
                    type="text"
                    className="export-path-input"
                    value={`${spriteColumns} × ${spriteRows} = ${spriteCellCount}`}
                    readOnly
                  />
                </div>
              </div>

              {spritePreset === "custom" && (
                <div className="export-inputs-row" style={{ marginTop: "8px" }}>
                  <div className="export-form-group">
                    <label>{t.spriteColumnsLabel}</label>
                    <input
                      type="number"
                      className="export-path-input"
                      value={spriteColumns}
                      min="1"
                      max="64"
                      onChange={(e) => {
                        setSpritePreset("custom");
                        setSpriteColumns(clampSpriteGridValue(parseInt(e.target.value, 10)));
                      }}
                    />
                  </div>
                  <div className="export-form-group">
                    <label>{t.spriteRowsLabel}</label>
                    <input
                      type="number"
                      className="export-path-input"
                      value={spriteRows}
                      min="1"
                      max="64"
                      onChange={(e) => {
                        setSpritePreset("custom");
                        setSpriteRows(clampSpriteGridValue(parseInt(e.target.value, 10)));
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="export-section-title" style={{ marginTop: "14px" }}>{t.insufficientFramesLabel}</div>
              <div className="export-inputs-row">
                <div className="export-form-group">
                  <label>{t.insufficientFramesLabel}</label>
                  <select
                    className="export-select-styled"
                    value={insufficientFrames}
                    onChange={(e) => setInsufficientFrames(e.target.value as any)}
                  >
                    <option value="repeat_last">{t.strategyRepeatLast}</option>
                    <option value="transparent">{t.strategyTransparent}</option>
                    <option value="error">{t.strategyError}</option>
                  </select>
                </div>
              </div>

              {/* Grid preview container */}
              <div style={{ marginTop: "12px" }}>
                <label style={{ display: "block", fontSize: "12px", marginBottom: "6px", color: "var(--text-muted)" }}>
                  {t.spritePreviewLabel}
                </label>
                <div
                  className="export-preview-grid"
                  style={{ gridTemplateColumns: `repeat(${spriteColumns}, minmax(0, 1fr))` }}
                >
                  {spritePreviewIndices.map((idx, index) => {
                    const frame = idx !== -1 ? frames[idx] : null;
                    return frame ? (
                      <div key={index} className="export-preview-cell">
                        <img src={getFrameUrl(jobId, frame.name)} alt="" />
                        <span>#{frame.index}</span>
                      </div>
                    ) : (
                      <div key={index} className="export-preview-cell empty">
                        -
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Sizing panel */}
          <div className="export-form-group">
            <div className="export-section-title">{t.sizeOptionsLabel}</div>
            <div className="export-inputs-row">
              <div className="export-form-group">
                <label>Sizing Method</label>
                <select
                  className="export-select-styled"
                  value={sizeMode}
                  onChange={(e) => setSizeMode(e.target.value as any)}
                >
                  <option value="source">{t.sizeModeSource}</option>
                  <option value="scale">{t.sizeModeScale}</option>
                  <option value="custom">{t.sizeModeCustom}</option>
                </select>
              </div>

              {sizeMode === "scale" && (
                <div className="export-form-group">
                  <label>{t.scaleFactorLabel}</label>
                  <div className="export-slider-container">
                    <input
                      type="range"
                      min="1"
                      max="16"
                      step="1"
                      value={scale}
                      onChange={(e) => setScale(parseInt(e.target.value, 10))}
                    />
                    <span className="export-slider-value">{scale}x</span>
                  </div>
                </div>
              )}

              {sizeMode === "custom" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div className="export-form-group" style={{ flex: 1 }}>
                      <label>{t.widthLabel}</label>
                      <input
                        type="number"
                        className="export-path-input"
                        value={customWidth}
                        onChange={(e) => handleWidthChange(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        min="1"
                      />
                    </div>
                    <div className="export-form-group" style={{ flex: 1 }}>
                      <label>{t.heightLabel}</label>
                      <input
                        type="number"
                        className="export-path-input"
                        value={customHeight}
                        onChange={(e) => handleHeightChange(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        min="1"
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <label className="export-checkbox-row">
                      <input
                        type="checkbox"
                        checked={keepAspect}
                        onChange={(e) => setKeepAspect(e.target.checked)}
                      />
                      <span>{t.keepAspectRatio}</span>
                    </label>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <label style={{ fontSize: "11px", color: "var(--text-muted)" }}>{t.fitModeLabel}</label>
                      <select
                        className="export-select-styled"
                        style={{ padding: "4px 24px 4px 10px", fontSize: "11px" }}
                        value={fitMode}
                        onChange={(e) => setFitMode(e.target.value as any)}
                      >
                        <option value="exact">Exact</option>
                        <option value="fit">Fit / Padding</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {sizeMode === "custom" && fitMode === "fit" && (
              <div className="export-form-group" style={{ marginTop: "8px" }}>
                <label>{t.backgroundColorLabel}</label>
                <input
                  type="text"
                  className="export-path-input"
                  placeholder="#00000000"
                  value={backgroundColor}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Export Summary specifications */}
          <div className="export-summary-box">
            <div className="export-section-title" style={{ color: "var(--text, #e6e6e6)", fontSize: "11px", marginBottom: "8px" }}>
              {t.exportSummaryLabel}
            </div>
            <div className="export-summary-grid">
              <div className="export-summary-item">
                <span className="export-summary-label">{t.totalFrames}</span>
                <span className="export-summary-val">{selectedFrameCount}</span>
              </div>
              <div className="export-summary-item">
                <span className="export-summary-label">{t.estimatedSize}</span>
                <span className="export-summary-val">
                  {totalOutputDimensions.w} × {totalOutputDimensions.h}
                </span>
              </div>
              {format === "gif" && (
                <div className="export-summary-item" style={{ gridColumn: "span 2" }}>
                  <span className="export-summary-label">{t.estimatedGifDuration}</span>
                  <span className="export-summary-val">
                    {(selectedFrameCount / fps).toFixed(2)}s
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* FOOTER ACTIONS */}
        <div className="export-footer">
          <button className="export-cancel-btn" onClick={onClose}>
            {t.exportCancelBtn}
          </button>
          <button
            className="export-action-btn"
            onClick={handleStartExport}
            disabled={!!namingValidationError || !outputPath.trim()}
          >
            <Sparkles size={16} />
            <span>{t.startExportBtn}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
