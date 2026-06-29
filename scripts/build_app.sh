#!/usr/bin/env bash
# One-shot build of the Perfect Pixel desktop app.
#   1. Build the Python backend sidecar (PyInstaller).
#   2. Build & bundle the Tauri app (React frontend + Rust shell + sidecar).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== [1/2] Building Python sidecar ==="
bash "$SCRIPT_DIR/build_sidecar.sh"

echo "=== [2/2] Building Tauri app ==="
cd "$REPO_ROOT/frontend"
if [ ! -d node_modules ]; then
  npm install
fi
npm run tauri build

echo ">> Done. Bundles are in $REPO_ROOT/frontend/src-tauri/target/release/bundle/"
