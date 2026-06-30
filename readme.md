# Perfect Pixel Enhanced

> **Auto detect, refine, and get perfect pixel art from single frames and video sequences.**

[English](readme.md) | [简体中文](readme_zh.md)

[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](#)

---

## 📌 Project Origin & Fork Information
This project is an enhanced **fork** of the original [theamusing/perfectPixel](https://github.com/theamusing/perfectPixel) repository.

While the original tool was designed for refining single static pixel-style images, this enhanced fork extends the core grid refinement algorithm to support **video processing**, **temporal stability tuning**, and provides a **standalone cross-platform desktop application**.

---

## ✨ Key Enhancements (This Fork)

### 1. Video Sequence & Temporal Stability Processing
- **Video to Pixel Art**: Extract, process, and refine MP4/MOV/AVI video frames into a pixel-perfect PNG sequence.
- **Auto-Grid Locking**: Detects the optimal pixel grid size on initial frames and locks it for the entire sequence to eliminate per-frame spatial jitter.
- **Vote Frames (`vote_frames`)**: Uses a multi-frame voting mechanism to establish the most stable coordinate grids.
- **Adaptive Grid & Temporal Smoothing**: Blends refined coordinates over time using exponential moving average (EMA) smoothing to ensure liquid-smooth movements without grid popping.
- **Denoising Preprocessing**: Filters compression artifacts on frames before grid estimation.

### 2. Standalone Desktop Client (Tauri + React + FastAPI)
- **Zero-Dependency Bundle**: Bundles a Python FastAPI processing server as a compiled sidecar executable. Users do not need Python, Node, or Rust installed to run the final app.
- **Spotify-Inspired Immersive Dark UI**: A sleek, charcoal-black player interface with interactive settings, a volume-slider style range scrubber, and custom dropdown selects.
- **Vertical Tactile Timeline**: A vertical snap-scrolling album timeline on the right. Scroll manually using mouse wheel (updating preview frames in real-time with kinetic snapping) or watch it automatically center active frames during playback.

---

## 📦 Installation

Perfect Pixel provides implementations with or without OpenCV. You can choose the one that fits your environment:

| Backend | File | Dependencies | Purpose |
| :--- | :--- | :--- | :--- |
| **OpenCV Backend** | [`perfect_pixel.py`](./src/perfect_pixel/perfect_pixel.py) | `opencv-python`, `numpy` | Default high-performance backend |
| **Lightweight Backend** | [`perfect_pixel_no_cv2.py`](./src/perfect_pixel/perfect_pixel_noCV2.py) | `numpy` | Lightweight backup (no cv2 required) |

Install the library via `pip`:
```bash
# Recommended: Fast version with OpenCV support
pip install perfect-pixel[opencv]

# Numpy version: Lightweight (NumPy only)
pip install perfect-pixel
```

---

## 🖥️ Desktop App Development

### 1. Prerequisite Setup (Python 3.11/3.12 recommended)
```bash
# Set up virtual environment and install backend requirements
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Development Run
You can run the full desktop client with one command:
```bash
cd frontend
npm install
npm run tauri dev # Launches React frontend and auto-spawns FastAPI backend sidecar
```
The Tauri shell handles the lifecycle of the Python server (logging to `backend.log` and passing dynamic port bindings).

### 3. Build Distributable Package
To pack the app into a standalone double-clickable installer (`.dmg`/`.app` on macOS, `.exe` on Windows):
```bash
bash scripts/build_app.sh
```
This runs the PyInstaller sidecar builder first, copying target binaries under `frontend/src-tauri/binaries/`, and compiles the Tauri bundle.

#### Installing & first launch (macOS)
The `.dmg` is a standard drag-and-drop installer: open it and drag **Perfect Pixel.app** into the **Applications** folder shortcut. (The hidden `.VolumeIcon.icns` is just the volume icon — normal.)

The release builds are **ad-hoc signed but not notarized** (no Apple Developer certificate), so on first launch macOS Gatekeeper will say it "cannot be verified." To open it:
- **Right-click** the app → **Open** → **Open anyway**; or
- Run `xattr -dr com.apple.quarantine "/Applications/Perfect Pixel.app"` in Terminal (removes the download quarantine flag).

After the first launch the prompt won't reappear.

---

## 🔌 ComfyUI Custom Node
A custom node integration is available to run Perfect Pixel directly inside ComfyUI:
- [`Learn how to use Perfect Pixel as a ComfyUI node`](integrations/comfyui/README.md)

---

## 🛠️ API & CLI Usage

### Static Image Refinement
```python
import cv2
from perfect_pixel import get_perfect_pixel

bgr = cv2.imread("images/avatar.png", cv2.IMREAD_COLOR)
rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

# Refine grid and sample
w, h, out = get_perfect_pixel(rgb)
```

### Video API Quick Test
```bash
# Submit video job (temporal stability defaults to on)
curl -F video=@test.mp4 -F output_scale=4 http://127.0.0.1:8765/api/jobs
# Poll job status
curl http://127.0.0.1:8765/api/jobs/<job_id>
```
See the full endpoint contract, parameter payloads, and sidecar integration details in [`docs/API.md`](./docs/API.md).

#### Temporal Stability Parameters
Video processing enables several temporal-stability mechanisms by default (all optional, exposed as form fields on `POST /api/jobs`):

| Parameter | Default | Purpose |
| :--- | :--- | :--- |
| `adaptive_grid` | `true` | Per-frame grid refinement EMA-blended with the previous frame |
| `grid_blend` | `0.7` | Previous-frame weight for the grid-line EMA `[0, 1]` |
| `temporal_smoothing` | `true` | Per-pixel EMA over output colours with change detection |
| `temporal_alpha` | `0.4` | Current-frame weight for the output EMA `(0, 1]` |
| `scene_change_threshold` | `30.0` | Pixels changing more than this bypass smoothing |
| `vote_frames` | `5` | Median-vote the locked grid size over the first N frames |
| `denoise` | `false` | Optional edge-preserving denoising of compression artifacts |
| `denoise_strength` | `5.0` | Denoising strength (`>=0`) |

Set `adaptive_grid=false` and `temporal_smoothing=false` together to reproduce the legacy "lock first-frame coordinates, no colour smoothing" behaviour.

---

## 🧮 Algorithm Overview
The core algorithm runs in three primary stages:
1. **Grid Detection**: Estimates optimal grid spacing from the Fast Fourier Transform (FFT) magnitude of the image luminance.
2. **Coordinate Refinement**: Performs 1D search on Sobel edges to align coordinate lines exactly to pixel boundaries.
3. **Resampling**: Samples the source pixels at aligned grid centers to output clean, crisp, pixel-perfect illustrations.

---

## 📄 License
This project is released under the **MIT License** — see [`LICENSE`](./LICENSE).
