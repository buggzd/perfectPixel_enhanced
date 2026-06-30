# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Perfect Pixel backend sidecar.

Produces an **onedir** bundle (a directory `perfect-pixel-api/` containing the
executable plus all libs/data), NOT a single onefile executable.

Why onedir: a onefile binary re-extracts its ~60 MB embedded archive to a temp
dir on *every* launch (10+ seconds of pure I/O before Python even starts).
onedir ships the libs already expanded, so startup is near-instant (~hundreds
of ms). Tauri bundles the whole directory via `resources`.

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

# onedir: EXE holds only the bootloader + scripts; binaries/datas go in COLLECT.
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="perfect-pixel-api",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # Tauri spawns this with CREATE_NO_WINDOW on Windows; stdout/stderr go to backend.log
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="perfect-pixel-api",
)

