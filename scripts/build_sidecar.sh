#!/usr/bin/env bash
# Build the Perfect Pixel Python backend as a single PyInstaller executable and
# place it where Tauri expects its sidecar (named with the Rust target triple).
#
#   frontend/src-tauri/binaries/perfect-pixel-api-<triple>
#
# Tauri's `bundle.externalBin` then picks it up at `tauri build` time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV="$REPO_ROOT/.venv"

if [ -x "$VENV/bin/python" ]; then
  PY="$VENV/bin/python"
else
  echo ">> .venv not found; creating one with python3"
  python3 -m venv "$VENV"
  PY="$VENV/bin/python"
fi

echo ">> Installing dependencies + pyinstaller"
"$PY" -m pip install --upgrade pip >/dev/null
"$PY" -m pip install -r "$REPO_ROOT/requirements.txt" pyinstaller >/dev/null

echo ">> Building sidecar executable"
cd "$REPO_ROOT"
"$PY" -m PyInstaller scripts/perfect_pixel_api.spec \
  --noconfirm \
  --distpath build/sidecar \
  --workpath build/pyi \
  --clean

# Resolve the Rust host target triple (e.g. aarch64-apple-darwin).
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$TRIPLE" ]; then
  echo "!! Could not determine rustc host triple. Is rustc installed?" >&2
  exit 1
fi

OUT_DIR="$REPO_ROOT/frontend/src-tauri/binaries"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/perfect-pixel-api-$TRIPLE"

cp "$REPO_ROOT/build/sidecar/perfect-pixel-api" "$OUT"
chmod +x "$OUT"

echo ">> Sidecar ready: $OUT"
