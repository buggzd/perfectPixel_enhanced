# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Perfect Pixel backend sidecar.

Produces a single self-contained executable (`perfect-pixel-api[-.exe]`) that
runs the FastAPI/uvicorn server without a Python install on the host.

Run from the repo root:
    pyinstaller scripts/perfect_pixel_api.spec \
        --noconfirm --distpath build/sidecar --workpath build/pyi
"""
import os
from PyInstaller.utils.hooks import collect_all

# SPECPATH is the directory containing this spec file (scripts/).
REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

datas = []
binaries = []
hiddenimports = [
    # uvicorn lazily imports these at runtime; PyInstaller can't see them.
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]

# Bundle the perfect_pixel package source (it lives under src/, not site-packages).
datas += [(os.path.join(REPO_ROOT, "src", "perfect_pixel"), "perfect_pixel")]

# opencv ships native libs / data files that need full collection.
for pkg in ("cv2",):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [os.path.join(REPO_ROOT, "api", "run.py")],
    pathex=[os.path.join(REPO_ROOT, "src"), REPO_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="perfect-pixel-api",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,  # Tauri spawns this with CREATE_NO_WINDOW on Windows; stdout/stderr go to backend.log
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
