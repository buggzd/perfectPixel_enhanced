// API client for connecting to the FastAPI backend at 127.0.0.1:8765

export const BASE_URL = "http://127.0.0.1:8765";

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
}

export interface JobStatusResponse {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  total_frames: number;
  current_frame: number;
  grid_size: { w: number; h: number } | null;
  output_frames: string[];
  error: string | null;
}

export interface FrameInfo {
  name: string;
  index: number;
}

export interface ListFramesResponse {
  frames: FrameInfo[];
}

/**
 * Checks if the backend is running and healthy
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
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

  const res = await fetch(`${BASE_URL}/api/jobs`, {
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
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch job status for ${jobId}`);
  }
  return res.json();
}

/**
 * Lists the output frames processed so far
 */
export async function getJobFrames(jobId: string): Promise<ListFramesResponse> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/frames`);
  if (!res.ok) {
    throw new Error(`Failed to list frames for ${jobId}`);
  }
  return res.json();
}

/**
 * Gets the direct URL of a single frame image for rendering in <img>
 */
export function getFrameUrl(jobId: string, frameName: string): string {
  return `${BASE_URL}/api/jobs/${jobId}/frames/${frameName}`;
}

/**
 * Cancels and deletes a job from the backend, freeing up space
 */
export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`Failed to delete job ${jobId}`);
  }
}
