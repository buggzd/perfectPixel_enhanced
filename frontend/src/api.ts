// API client for connecting to the FastAPI backend.
//
// The backend base URL is resolved at runtime (the Tauri shell picks a free
// port and spawns the Python sidecar, then exposes its URL via the
// `backend_url` command). The frontend calls `setBaseUrl` during boot before
// issuing any request. A sensible default is kept so plain `npm run dev`
// (without Tauri) still talks to a manually-started `python -m api.run`.

let baseUrl = "http://127.0.0.1:8765";

export function getBaseUrl(): string {
  return baseUrl;
}

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, "");
}

export interface JobOptions {
  sample_method: "majority" | "center" | "median";
  grid_size_w: number | null;
  grid_size_h: number | null;
  refine_intensity: number; // [0, 0.5]
  fix_square: boolean;
  min_size: number;
  peak_width: number;
  output_scale: number; // [1, 16]
  every_n_frames: number; // >= 1
  adaptive_grid?: boolean;
  grid_blend?: number;
  temporal_smoothing?: boolean;
  temporal_alpha?: number;
  scene_change_threshold?: number;
  vote_frames?: number;
  denoise?: boolean;
  denoise_strength?: number;
  max_workers?: number;
}

export interface JobStatusResponse {
  id: string;
  status: "queued" | "running" | "done" | "error";
  stage: "queued" | "pixelating" | "background_removal" | "done" | "error";
  progress: number;
  total_frames: number;
  current_frame: number;
  grid_size: { w: number; h: number } | null;
  output_frame_count: number;
  keyframe_count?: number;
  keyframe_threshold?: number;
  keyframe_method?: "adjacent" | "flow";
  latest_frame: string | null;
  output_frames?: string[];
  error: string | null;
}

export interface FrameInfo {
  name: string;
  index: number;
  is_keyframe?: boolean;
  change_score?: number;
  keyframe_method?: "adjacent" | "flow";
}

export interface ListFramesResponse {
  frames: FrameInfo[];
}

export interface KeyframeAnalysisResponse {
  frames: FrameInfo[];
  keyframe_count: number;
  keyframe_threshold: number;
  keyframe_method: "adjacent" | "flow";
}

/**
 * Checks if the backend is running and healthy
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/health`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === "ok";
  } catch (e) {
    return false;
  }
}

/**
 * Creates a new video pixelation job by uploading the video file
 */
export async function createJob(
  videoFile: File,
  options: JobOptions
): Promise<{ job_id: string; status: string }> {
  const formData = new FormData();
  formData.append("video", videoFile);
  formData.append("sample_method", options.sample_method);

  if (options.grid_size_w !== null) {
    formData.append("grid_size_w", options.grid_size_w.toString());
  }
  if (options.grid_size_h !== null) {
    formData.append("grid_size_h", options.grid_size_h.toString());
  }

  formData.append("refine_intensity", options.refine_intensity.toString());
  formData.append("fix_square", options.fix_square ? "true" : "false");
  formData.append("min_size", options.min_size.toString());
  formData.append("peak_width", options.peak_width.toString());
  formData.append("output_scale", options.output_scale.toString());
  formData.append("every_n_frames", options.every_n_frames.toString());

  if (options.adaptive_grid !== undefined) {
    formData.append("adaptive_grid", options.adaptive_grid ? "true" : "false");
  }
  if (options.grid_blend !== undefined) {
    formData.append("grid_blend", options.grid_blend.toString());
  }
  if (options.temporal_smoothing !== undefined) {
    formData.append("temporal_smoothing", options.temporal_smoothing ? "true" : "false");
  }
  if (options.temporal_alpha !== undefined) {
    formData.append("temporal_alpha", options.temporal_alpha.toString());
  }
  if (options.scene_change_threshold !== undefined) {
    formData.append("scene_change_threshold", options.scene_change_threshold.toString());
  }
  if (options.vote_frames !== undefined) {
    formData.append("vote_frames", options.vote_frames.toString());
  }
  if (options.denoise !== undefined) {
    formData.append("denoise", options.denoise ? "true" : "false");
  }
  if (options.denoise_strength !== undefined) {
    formData.append("denoise_strength", options.denoise_strength.toString());
  }
  if (options.max_workers !== undefined) {
    formData.append("max_workers", options.max_workers.toString());
  }
  const res = await fetch(`${getBaseUrl()}/api/jobs`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to create job (${res.status})`);
  }

  return res.json();
}

/**
 * Gets the current status of a job
 */
export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
  const res = await fetch(`${getBaseUrl()}/api/jobs/${jobId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch job status for ${jobId}`);
  }
  return res.json();
}

/**
 * Lists the output frames processed so far
 */
export async function getJobFrames(jobId: string): Promise<ListFramesResponse> {
  const res = await fetch(`${getBaseUrl()}/api/jobs/${jobId}/frames`);
  if (!res.ok) {
    throw new Error(`Failed to list frames for ${jobId}`);
  }
  return res.json();
}

export async function analyzeJobKeyframes(
  jobId: string,
  request: { threshold: number; method: "adjacent" | "flow" }
): Promise<KeyframeAnalysisResponse> {
  const res = await fetch(`${getBaseUrl()}/api/jobs/${jobId}/keyframes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to analyze keyframes (${res.status})`);
  }
  return res.json();
}

/**
 * Gets the direct URL of a single frame image for rendering in <img>
 */
export function getFrameUrl(jobId: string, frameName: string, cacheKey?: string | number): string {
  const url = `${getBaseUrl()}/api/jobs/${jobId}/frames/${frameName}`;
  return cacheKey === undefined ? url : `${url}?v=${encodeURIComponent(String(cacheKey))}`;
}

export function getBackgroundPreviewUrl(
  jobId: string,
  frameName: string,
  backgroundColor: string | null,
  threshold: number,
  feather: number,
  blockSize: number,
  edgeConnected: boolean = true
): string {
  const params = new URLSearchParams({
    threshold: threshold.toString(),
    feather: feather.toString(),
    block_size: blockSize.toString(),
    edge_connected: edgeConnected.toString(),
  });
  if (backgroundColor) {
    params.set("background_color", backgroundColor);
  }
  return `${getBaseUrl()}/api/jobs/${jobId}/background-preview/${frameName}?${params.toString()}`;
}

export async function applyBackgroundRemoval(
  jobId: string,
  request: {
    background_color: string | null;
    threshold: number;
    feather: number;
    block_size: number;
    edge_connected?: boolean;
  }
): Promise<{ job_id: string; status: string }> {
  const res = await fetch(`${getBaseUrl()}/api/jobs/${jobId}/background-removal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threshold: request.threshold,
      feather: request.feather,
      block_size: request.block_size,
      edge_connected: request.edge_connected ?? true,
      ...(request.background_color ? { background_color: request.background_color } : {}),
    }),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to apply background removal (${res.status})`);
  }
  return res.json();
}

/**
 * Cancels and deletes a job from the backend, freeing up space
 */
export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/jobs/${jobId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`Failed to delete job ${jobId}`);
  }
}

// --- Export-related Types and APIs ---

export type ExportFormat = "png_sequence" | "gif" | "sprite_sheet" | "sprite_sheet_4x4" | "single_png";

export interface ExportFrameSelection {
  mode: "all" | "current" | "range" | "indices";
  start?: number;
  end?: number;
  indices?: number[];
  every_n_frames?: number;
  target_fps?: number;
  max_frames?: number;
  sprite_sampling?: "first_16" | "from_current" | "even_16";
  insufficient_frames?: "repeat_last" | "transparent" | "error";
}

export interface ExportSizeOptions {
  mode: "source" | "scale" | "custom";
  scale?: number;
  width?: number;
  height?: number;
  keep_aspect?: boolean;
  fit?: "exact" | "fit";
  background?: string;
}

export interface CreateExportRequest {
  format: ExportFormat;
  output_path: string;
  filename_template?: string;
  index_start?: number;
  overwrite?: boolean;
  fps?: number;
  loop?: boolean;
  frame_selection: ExportFrameSelection;
  size: ExportSizeOptions;
  sprite_pad?: "repeat_last" | "transparent" | "error";
  sprite_columns?: number;
  sprite_rows?: number;
}

export interface ExportStatusResponse {
  export_id: string;
  job_id: string;
  format: ExportFormat;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  total_items: number;
  current_item: number;
  output_path: string;
  written_files: string[];
  error: string | null;
}

export interface JobMetadataResponse {
  id: string;
  source_video_name: string;
  source_fps: number;
  source_frame_count: number;
  processed_fps: number;
  processed_frame_count: number;
  frame_width: number | null;
  frame_height: number | null;
  grid_size: { w: number; h: number } | null;
}

/**
 * Gets the video metadata and frame specs for a completed job
 */
export async function getJobMetadata(jobId: string): Promise<JobMetadataResponse> {
  const res = await fetch(`${getBaseUrl()}/api/jobs/${jobId}/metadata`);
  if (!res.ok) {
    throw new Error(`Failed to fetch metadata for job ${jobId}`);
  }
  return res.json();
}

/**
 * Initiates an export task for a given job
 */
export async function createExport(
  jobId: string,
  request: CreateExportRequest
): Promise<{ export_id: string; status: string }> {
  const res = await fetch(`${getBaseUrl()}/api/jobs/${jobId}/exports`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to create export task (${res.status})`);
  }

  return res.json();
}

/**
 * Gets the status of an active export task
 */
export async function getExportStatus(
  jobId: string,
  exportId: string
): Promise<ExportStatusResponse> {
  const res = await fetch(`${getBaseUrl()}/api/jobs/${jobId}/exports/${exportId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch export status for export ${exportId}`);
  }
  return res.json();
}
