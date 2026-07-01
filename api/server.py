"""
Perfect Pixel video backend — FastAPI HTTP API.

A Tauri front-end launches this server as a sidecar (see ``api/run.py``) and
drives video → pixel-perfect frame-sequence jobs over HTTP.

Run:
    python -m api.run          # uvicorn on 127.0.0.1:8765
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

# Make ``src`` importable when the server is run from the repo root without an
# editable install of the perfect_pixel package.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC_DIR = os.path.join(_REPO_ROOT, "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)

import cv2  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from perfect_pixel.background import remove_background_from_frames  # noqa: E402
from perfect_pixel.exporting import (  # noqa: E402
    ExportError,
    VALID_EXPORT_FORMATS,
    export_gif,
    export_png_sequence,
    export_single_png,
    export_sprite_sheet_4x4,
)
from perfect_pixel.video import analyze_keyframes, process_video  # noqa: E402

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST = os.getenv("PERFECT_PIXEL_HOST", "127.0.0.1")
PORT = int(os.getenv("PERFECT_PIXEL_PORT", "8765"))
JOBS_DIR = os.getenv(
    "PERFECT_PIXEL_JOBS_DIR",
    os.path.join(_REPO_ROOT, "jobs"),
)
os.makedirs(JOBS_DIR, exist_ok=True)

VALID_SAMPLE_METHODS = {"center", "median", "majority"}


# ---------------------------------------------------------------------------
# Job model
# ---------------------------------------------------------------------------

@dataclass
class Job:
    job_id: str
    work_dir: str
    frames_dir: str
    status: str = "queued"          # queued | running | done | error
    stage: str = "queued"           # queued | pixelating | background_removal | done | error
    progress: float = 0.0           # 0..1
    total_frames: int = 0
    current_frame: int = 0
    grid_size: Optional[dict] = None
    output_frames: list = field(default_factory=list)
    frame_metadata: list = field(default_factory=list)
    keyframe_threshold: float = 8.0
    keyframe_method: str = "adjacent"
    error: Optional[str] = None
    cancel_flag: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    # --- source / processed metadata (for export sizing & fps) ---
    source_video_name: str = ""
    source_fps: float = 0.0
    source_frame_count: int = 0
    processed_fps: float = 0.0
    frame_width: Optional[int] = None
    frame_height: Optional[int] = None
    # --- export tasks keyed by export_id ---
    exports: Dict[str, "ExportJob"] = field(default_factory=dict)

    def snapshot(self, *, include_output_frames: bool = False) -> dict:
        with self._lock:
            output_count = len(self.output_frames)
            latest_frame = self.output_frames[-1] if output_count else None
            data = {
                "id": self.job_id,
                "status": self.status,
                "stage": self.stage,
                "progress": round(self.progress, 4),
                "total_frames": self.total_frames,
                "current_frame": self.current_frame,
                "grid_size": self.grid_size,
                "output_frame_count": output_count,
                "keyframe_count": sum(1 for frame in self.frame_metadata if frame.get("is_keyframe")),
                "keyframe_threshold": self.keyframe_threshold,
                "keyframe_method": self.keyframe_method,
                "latest_frame": latest_frame,
                "error": self.error,
            }
            if include_output_frames:
                data["output_frames"] = list(self.output_frames)
            return data


@dataclass
class ExportJob:
    export_id: str
    job_id: str
    format: str
    output_path: str
    status: str = "queued"          # queued | running | done | error
    progress: float = 0.0           # 0..1
    total_items: int = 0
    current_item: int = 0
    written_files: list = field(default_factory=list)
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "export_id": self.export_id,
                "job_id": self.job_id,
                "format": self.format,
                "status": self.status,
                "progress": round(self.progress, 4),
                "total_items": self.total_items,
                "current_item": self.current_item,
                "output_path": self.output_path,
                "written_files": list(self.written_files),
                "error": self.error,
            }


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()


def _get_job(job_id: str) -> Job:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    return job


# ---------------------------------------------------------------------------
# Background worker
# ---------------------------------------------------------------------------

def _run_job(
    job: Job,
    video_path: str,
    *,
    sample_method: str,
    grid_size: Optional[tuple],
    refine_intensity: float,
    fix_square: bool,
    min_size: float,
    peak_width: int,
    output_scale: int,
    every_n_frames: int,
    adaptive_grid: bool,
    grid_blend: float,
    temporal_smoothing: bool,
    temporal_alpha: float,
    scene_change_threshold: float,
    vote_frames: int,
    denoise: bool,
    denoise_strength: float,
) -> None:
    def on_progress(current: int, total: int) -> None:
        if job.cancel_flag.is_set():
            raise RuntimeError("cancelled")
        with job._lock:
            job.current_frame = current
            if total > 0:
                job.progress = current / total
                job.total_frames = total

    try:
        with job._lock:
            job.status = "running"
            job.stage = "pixelating"

        result = process_video(
            video_path,
            job.frames_dir,
            sample_method=sample_method,
            grid_size=grid_size,
            refine_intensity=refine_intensity,
            fix_square=fix_square,
            min_size=min_size,
            peak_width=peak_width,
            output_scale=output_scale,
            every_n_frames=every_n_frames,
            progress_callback=on_progress,
            adaptive_grid=adaptive_grid,
            grid_blend=grid_blend,
            temporal_smoothing=temporal_smoothing,
            temporal_alpha=temporal_alpha,
            scene_change_threshold=scene_change_threshold,
            vote_frames=vote_frames,
            denoise=denoise,
            denoise_strength=denoise_strength,
        )

        with job._lock:
            job.grid_size = result["grid_size"]
            job.total_frames = result["total_frames"]
            job.output_frames = result["output_frames"]
            job.frame_metadata = []
            job.current_frame = result["total_frames"]
            job.progress = 1.0
            job.status = "done"
            job.stage = "done"
            # Record processed frame dimensions for export sizing, read from
            # the first written frame (all output frames share dimensions).
            if result["output_frames"]:
                first = os.path.join(job.frames_dir, result["output_frames"][0])
                img = cv2.imread(first, cv2.IMREAD_COLOR)
                if img is not None:
                    job.frame_height, job.frame_width = img.shape[:2]

    except Exception as exc:  # noqa: BLE001
        with job._lock:
            job.status = "error"
            job.stage = "error"
            job.error = str(exc) if not job.cancel_flag.is_set() else "cancelled"


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Perfect Pixel Video API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # Tauri uses tauri://localhost / http://localhost:*
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/jobs")
def create_job(
    video: UploadFile = File(...),
    sample_method: str = Form("majority"),
    grid_size_w: Optional[int] = Form(None),
    grid_size_h: Optional[int] = Form(None),
    refine_intensity: float = Form(0.25),
    fix_square: bool = Form(True),
    min_size: float = Form(4.0),
    peak_width: int = Form(6),
    output_scale: int = Form(1),
    every_n_frames: int = Form(1),
    adaptive_grid: bool = Form(True),
    grid_blend: float = Form(0.7),
    temporal_smoothing: bool = Form(True),
    temporal_alpha: float = Form(0.4),
    scene_change_threshold: float = Form(30.0),
    vote_frames: int = Form(5),
    denoise: bool = Form(False),
    denoise_strength: float = Form(5.0),
):
    if sample_method not in VALID_SAMPLE_METHODS:
        raise HTTPException(
            status_code=400,
            detail=f"sample_method must be one of {sorted(VALID_SAMPLE_METHODS)}",
        )
    if not (0.0 <= refine_intensity <= 0.5):
        raise HTTPException(status_code=400, detail="refine_intensity must be in [0, 0.5]")
    if output_scale < 1 or output_scale > 16:
        raise HTTPException(status_code=400, detail="output_scale must be in [1, 16]")
    if every_n_frames < 1:
        raise HTTPException(status_code=400, detail="every_n_frames must be >= 1")
    if not (0.0 <= grid_blend <= 1.0):
        raise HTTPException(status_code=400, detail="grid_blend must be in [0, 1]")
    if not (0.0 < temporal_alpha <= 1.0):
        raise HTTPException(status_code=400, detail="temporal_alpha must be in (0, 1]")
    if vote_frames < 0:
        raise HTTPException(status_code=400, detail="vote_frames must be >= 0")
    if denoise_strength < 0:
        raise HTTPException(status_code=400, detail="denoise_strength must be >= 0")
    grid_size = None
    if grid_size_w is not None and grid_size_h is not None:
        if grid_size_w <= 0 or grid_size_h <= 0:
            raise HTTPException(status_code=400, detail="grid_size_w/grid_size_h must be > 0")
        grid_size = (grid_size_w, grid_size_h)

    job_id = uuid.uuid4().hex[:16]
    work_dir = os.path.join(JOBS_DIR, job_id)
    frames_dir = os.path.join(work_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    # Persist the uploaded video. Keep the original extension so cv2 is happy.
    suffix = os.path.splitext(video.filename or "input.mp4")[1] or ".mp4"
    video_path = os.path.join(work_dir, f"input{suffix}")
    with open(video_path, "wb") as fh:
        shutil.copyfileobj(video.file, fh)

    job = Job(job_id=job_id, work_dir=work_dir, frames_dir=frames_dir)
    job.source_video_name = os.path.splitext(video.filename or "input")[0]
    # Probe source fps / frame count for export time-axis resampling & metadata.
    cap = cv2.VideoCapture(video_path)
    if cap.isOpened():
        sf = cap.get(cv2.CAP_PROP_FPS)
        sc = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        if sf and sf > 0:
            job.source_fps = float(sf)
        if sc and sc > 0:
            job.source_frame_count = int(sc)
        cap.release()
    job.processed_fps = (job.source_fps / every_n_frames) if job.source_fps else 0.0

    with _jobs_lock:
        _jobs[job_id] = job

    thread = threading.Thread(
        target=_run_job,
        kwargs=dict(
            job=job,
            video_path=video_path,
            sample_method=sample_method,
            grid_size=grid_size,
            refine_intensity=refine_intensity,
            fix_square=fix_square,
            min_size=min_size,
            peak_width=peak_width,
            output_scale=output_scale,
            every_n_frames=every_n_frames,
            adaptive_grid=adaptive_grid,
            grid_blend=grid_blend,
            temporal_smoothing=temporal_smoothing,
            temporal_alpha=temporal_alpha,
            scene_change_threshold=scene_change_threshold,
            vote_frames=vote_frames,
            denoise=denoise,
            denoise_strength=denoise_strength,
        ),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "status": job.status}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, include_output_frames: bool = False):
    return _get_job(job_id).snapshot(include_output_frames=include_output_frames)


@app.get("/api/jobs/{job_id}/frames")
def list_frames(job_id: str):
    job = _get_job(job_id)
    with job._lock:
        if job.frame_metadata:
            return {"frames": list(job.frame_metadata)}
    frames = []
    for name in sorted(os.listdir(job.frames_dir)) if os.path.isdir(job.frames_dir) else []:
        if not name.lower().endswith(".png"):
            continue
        # cheap width/height via cv2 would add a dependency on import time; use
        # the filename index instead and let clients read dims from the image.
        try:
            idx = int(name.split("_")[1].split(".")[0])
        except (IndexError, ValueError):
            idx = -1
        frames.append({"name": name, "index": idx})
    return {"frames": frames}


class KeyframeAnalysisRequest(BaseModel):
    threshold: float = 8.0
    method: str = "adjacent"


@app.post("/api/jobs/{job_id}/keyframes")
def analyze_job_keyframes(job_id: str, req: KeyframeAnalysisRequest):
    job = _get_job(job_id)
    if req.threshold < 0:
        raise HTTPException(status_code=400, detail="threshold must be >= 0")
    if req.method not in {"adjacent", "flow"}:
        raise HTTPException(status_code=400, detail="method must be adjacent or flow")

    with job._lock:
        if job.status != "done":
            raise HTTPException(
                status_code=409,
                detail=f"job must be done before keyframe analysis (status={job.status})",
            )
        frames_dir = job.frames_dir
        output_frames = list(job.output_frames)

    if not output_frames:
        raise HTTPException(status_code=409, detail="job has no processed frames")

    try:
        metadata = analyze_keyframes(
            frames_dir,
            output_frames,
            keyframe_threshold=req.threshold,
            keyframe_method=req.method,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    keyframe_count = sum(1 for frame in metadata if frame.get("is_keyframe"))
    with job._lock:
        job.frame_metadata = metadata
        job.keyframe_threshold = req.threshold
        job.keyframe_method = req.method

    return {
        "frames": metadata,
        "keyframe_count": keyframe_count,
        "keyframe_threshold": req.threshold,
        "keyframe_method": req.method,
    }


@app.get("/api/jobs/{job_id}/frames/{name}")
def get_frame(job_id: str, name: str):
    job = _get_job(job_id)
    # Reject path traversal.
    if "/" in name or "\\" in name or not name.lower().endswith(".png"):
        raise HTTPException(status_code=400, detail="invalid frame name")
    path = os.path.join(job.frames_dir, name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="frame not found")
    return FileResponse(path, media_type="image/png")


@app.get("/api/jobs/{job_id}/background-preview/{name}")
def preview_background_removed_frame(
    job_id: str,
    name: str,
    background_color: Optional[str] = None,
    threshold: float = 30.0,
    feather: int = 0,
    block_size: int = 1,
    edge_connected: bool = True,
):
    job = _get_job(job_id)
    if "/" in name or "\\" in name or not name.lower().endswith(".png"):
        raise HTTPException(status_code=400, detail="invalid frame name")
    if threshold < 0:
        raise HTTPException(status_code=400, detail="threshold must be >= 0")
    if feather < 0 or feather > 8:
        raise HTTPException(status_code=400, detail="feather must be in [0, 8]")
    if block_size < 1:
        raise HTTPException(status_code=400, detail="block_size must be >= 1")
    path = os.path.join(job.frames_dir, name)
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise HTTPException(status_code=404, detail="frame not found")
    try:
        if background_color:
            from perfect_pixel.background import parse_bgr_color
            parse_bgr_color(background_color)
        from perfect_pixel.background import remove_background_bgra
        out = remove_background_bgra(
            img,
            background_color=background_color,
            threshold=threshold,
            feather=feather,
            block_size=block_size,
            edge_connected=edge_connected,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    ok, encoded = cv2.imencode(".png", out)
    if not ok:
        raise HTTPException(status_code=500, detail="failed to encode preview")
    return Response(content=encoded.tobytes(), media_type="image/png")


class BackgroundRemovalRequest(BaseModel):
    background_color: Optional[str] = None
    threshold: float = 30.0
    feather: int = 0
    block_size: int = 1
    edge_connected: bool = True


@app.post("/api/jobs/{job_id}/background-removal")
def apply_background_removal(job_id: str, req: BackgroundRemovalRequest):
    job = _get_job(job_id)
    if req.threshold < 0:
        raise HTTPException(status_code=400, detail="threshold must be >= 0")
    if req.feather < 0 or req.feather > 8:
        raise HTTPException(status_code=400, detail="feather must be in [0, 8]")
    if req.block_size < 1:
        raise HTTPException(status_code=400, detail="block_size must be >= 1")
    if req.background_color:
        try:
            from perfect_pixel.background import parse_bgr_color
            parse_bgr_color(req.background_color)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    with job._lock:
        if job.status != "done":
            raise HTTPException(
                status_code=409,
                detail=f"job must be done before background removal (status={job.status})",
            )
        job.status = "running"
        job.stage = "background_removal"
        job.progress = 0.0
        job.current_frame = 0
        job.total_frames = len(job.output_frames)

    def on_progress(current: int, total: int) -> None:
        if job.cancel_flag.is_set():
            raise RuntimeError("cancelled")
        with job._lock:
            job.current_frame = current
            job.total_frames = total
            job.progress = current / total if total > 0 else 1.0

    def worker() -> None:
        try:
            remove_background_from_frames(
                job.frames_dir,
                job.output_frames,
                background_color=req.background_color,
                threshold=req.threshold,
                feather=req.feather,
                block_size=req.block_size,
                edge_connected=req.edge_connected,
                progress_callback=on_progress,
            )
            with job._lock:
                job.status = "done"
                job.stage = "done"
                job.progress = 1.0
                job.current_frame = job.total_frames
        except Exception as exc:  # noqa: BLE001
            with job._lock:
                job.status = "error"
                job.stage = "error"
                job.error = str(exc) if not job.cancel_flag.is_set() else "cancelled"

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return {"job_id": job_id, "status": job.status}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = _get_job(job_id)
    job.cancel_flag.set()
    with _jobs_lock:
        _jobs.pop(job_id, None)
    # Best-effort cleanup; the worker may still hold files briefly.
    shutil.rmtree(job.work_dir, ignore_errors=True)
    return JSONResponse({"id": job_id, "deleted": True})


@app.on_event("startup")
def _startup():  # pragma: no cover
    # Clean stale job dirs from a previous run.
    if os.path.isdir(JOBS_DIR):
        for name in os.listdir(JOBS_DIR):
            shutil.rmtree(os.path.join(JOBS_DIR, name), ignore_errors=True)


# ---------------------------------------------------------------------------
# Export jobs
# ---------------------------------------------------------------------------

class ExportRequest(BaseModel):
    format: str
    output_path: str
    filename_template: Optional[str] = None
    index_start: int = 0
    overwrite: bool = False
    fps: Optional[float] = None
    loop: bool = True
    frame_selection: Dict[str, Any]
    size: Dict[str, Any]
    sprite_pad: str = "repeat_last"


def _get_export(job: Job, export_id: str) -> ExportJob:
    exp = job.exports.get(export_id)
    if exp is None:
        raise HTTPException(status_code=404, detail=f"Export not found: {export_id}")
    return exp


def _running_exports(job: Job) -> Optional[ExportJob]:
    for exp in job.exports.values():
        if exp.status in ("queued", "running"):
            return exp
    return None


def _run_export(job: Job, exp: ExportJob, req: ExportRequest) -> None:
    """Background worker: dispatch to the right exporter and update state."""
    def on_progress(current: int, total: int) -> None:
        with exp._lock:
            exp.current_item = current
            exp.total_items = total
            if total > 0:
                exp.progress = current / total

    try:
        with exp._lock:
            exp.status = "running"

        common = dict(
            frames_dir=job.frames_dir,
            output_frames=job.output_frames,
            output_path=req.output_path,
            overwrite=req.overwrite,
            frame_selection=req.frame_selection,
            processed_fps=job.processed_fps or None,
            size=req.size,
            on_progress=on_progress,
        )
        project = job.source_video_name or job.job_id
        source = job.source_video_name or "source"

        if req.format == "png_sequence":
            result = export_png_sequence(
                **common,
                filename_template=req.filename_template or "{project}_{index:04}",
                index_start=req.index_start,
                fps=req.fps,
                project_name=project,
                source_name=source,
            )
        elif req.format == "gif":
            fps = req.fps if req.fps is not None else 12.0
            result = export_gif(
                **common, fps=fps, loop=req.loop,
            )
        elif req.format == "sprite_sheet_4x4":
            result = export_sprite_sheet_4x4(
                **common,
                fps=req.fps,
                pad_mode=req.sprite_pad,
                project_name=project,
                source_name=source,
            )
        else:  # single_png
            result = export_single_png(**common)

        with exp._lock:
            exp.written_files = list(result.get("written_files", []))
            exp.progress = 1.0
            exp.current_item = exp.total_items or exp.current_item
            exp.status = "done"
    except ExportError as exc:
        with exp._lock:
            exp.status = "error"
            exp.error = str(exc)
    except Exception as exc:  # noqa: BLE001
        with exp._lock:
            exp.status = "error"
            exp.error = f"export failed: {exc}"


@app.get("/api/jobs/{job_id}/metadata")
def get_job_metadata(job_id: str):
    job = _get_job(job_id)
    with job._lock:
        grid = job.grid_size
        return {
            "id": job.job_id,
            "source_video_name": job.source_video_name,
            "source_fps": job.source_fps,
            "source_frame_count": job.source_frame_count,
            "processed_fps": job.processed_fps,
            "processed_frame_count": len(job.output_frames),
            "keyframe_count": sum(1 for frame in job.frame_metadata if frame.get("is_keyframe")),
            "keyframe_threshold": job.keyframe_threshold,
            "keyframe_method": job.keyframe_method,
            "frame_width": job.frame_width,
            "frame_height": job.frame_height,
            "grid_size": {"w": grid["w"], "h": grid["h"]} if grid else None,
            "status": job.status,
        }


@app.post("/api/jobs/{job_id}/exports")
def create_export(job_id: str, req: ExportRequest):
    job = _get_job(job_id)

    # Validate up front → 400 for bad params.
    if req.format not in VALID_EXPORT_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"format must be one of {sorted(VALID_EXPORT_FORMATS)}",
        )
    if not req.output_path or not req.output_path.strip():
        raise HTTPException(status_code=400, detail="output_path must not be empty")

    with job._lock:
        if job.status != "done":
            raise HTTPException(
                status_code=409,
                detail=f"job must be done before exporting (status={job.status})",
            )
        if not job.output_frames:
            raise HTTPException(status_code=409, detail="job has no processed frames")
        running = _running_exports(job)

    if running is not None:
        raise HTTPException(
            status_code=409,
            detail=f"an export is already running on this job: {running.export_id}",
        )

    if req.format == "png_sequence" and not req.filename_template:
        raise HTTPException(
            status_code=400, detail="filename_template is required for png_sequence"
        )
    if req.format == "gif" and req.fps is not None and not (1.0 <= req.fps <= 60.0):
        raise HTTPException(status_code=400, detail="fps must be in [1, 60]")

    # Synchronous pre-validation of the spec so bad params return 400 instead of
    # surfacing as an async error status after the worker starts.
    try:
        from perfect_pixel.exporting import (
            compute_export_size,
            select_frames,
            validate_filename_template,
        )
        if req.format == "png_sequence":
            validate_filename_template(req.filename_template)  # type: ignore[arg-type]
        if req.format == "single_png":
            sel = select_frames(
                req.frame_selection,
                total_frames=len(job.output_frames),
                processed_fps=job.processed_fps or None,
            )
            if len(sel) != 1:
                raise HTTPException(
                    status_code=400,
                    detail="single_png requires exactly one selected frame",
                )
        else:
            select_frames(
                req.frame_selection,
                total_frames=len(job.output_frames),
                processed_fps=job.processed_fps or None,
            )
        if job.frame_width and job.frame_height:
            compute_export_size(req.size, job.frame_width, job.frame_height)
    except HTTPException:
        raise
    except ExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    export_id = uuid.uuid4().hex[:8]
    exp = ExportJob(
        export_id=export_id,
        job_id=job_id,
        format=req.format,
        output_path=req.output_path,
    )
    with job._lock:
        job.exports[export_id] = exp

    thread = threading.Thread(
        target=_run_export, args=(job, exp, req), daemon=True
    )
    thread.start()

    return {"export_id": export_id, "status": exp.status}


@app.get("/api/jobs/{job_id}/exports/{export_id}")
def get_export(job_id: str, export_id: str):
    job = _get_job(job_id)
    return _get_export(job, export_id).snapshot()
