"""
Perfect Pixel video backend — FastAPI HTTP API.

A Tauri front-end launches this server as a sidecar (see ``api/run.py``) and
drives video → pixel-perfect frame-sequence jobs over HTTP.

Run:
    python -m api.run          # uvicorn on 127.0.0.1:8765
"""

from __future__ import annotations

import os
import shutil
import sys
import threading
import uuid
from dataclasses import dataclass, field
from typing import Optional

# Make ``src`` importable when the server is run from the repo root without an
# editable install of the perfect_pixel package.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC_DIR = os.path.join(_REPO_ROOT, "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from perfect_pixel.video import process_video  # noqa: E402

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
    progress: float = 0.0           # 0..1
    total_frames: int = 0
    current_frame: int = 0
    grid_size: Optional[dict] = None
    output_frames: list = field(default_factory=list)
    error: Optional[str] = None
    cancel_flag: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "id": self.job_id,
                "status": self.status,
                "progress": round(self.progress, 4),
                "total_frames": self.total_frames,
                "current_frame": self.current_frame,
                "grid_size": self.grid_size,
                "output_frames": list(self.output_frames),
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
        )

        with job._lock:
            job.grid_size = result["grid_size"]
            job.total_frames = result["total_frames"]
            job.output_frames = result["output_frames"]
            job.current_frame = result["total_frames"]
            job.progress = 1.0
            job.status = "done"

    except Exception as exc:  # noqa: BLE001
        with job._lock:
            job.status = "error"
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
async def create_job(
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
        ),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "status": job.status}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return _get_job(job_id).snapshot()


@app.get("/api/jobs/{job_id}/frames")
def list_frames(job_id: str):
    job = _get_job(job_id)
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
