#!/usr/bin/env bash
# Build the Perfect Pixel Python backend as a PyInstaller **onedir** bundle and
# place it where Tauri expects its sidecar (named with the Rust target triple).
#
#   frontend/src-tauri/binaries/perfect-pixel-api-<triple>/
#       perfect-pixel-api          (executable)
#       ... (libs, datas)
#
# onedir (vs onefile) avoids the 10+ second temp-dir extraction on every launch
# that made the app feel slow to start. Tauri bundles the whole directory via
# `resources` (see tauri.conf.json / lib.rs), not `externalBin`.
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

echo ">> Building sidecar (onedir)"
cd "$REPO_ROOT"
"$PY" -m PyInstaller scripts/perfect_pixel_api.spec \
  --noconfirm \
  --distpath build/sidecar \
  --workpath build/pyi \
  --clean

# PyInstaller onedir emits build/sidecar/perfect-pixel-api/perfect-pixel-api
SRC_DIR="$REPO_ROOT/build/sidecar/perfect-pixel-api"
if [ ! -x "$SRC_DIR/perfect-pixel-api" ]; then
  echo "!! Expected onedir bundle at $SRC_DIR/perfect-pixel-api not found" >&2
  exit 1
fi

# Copy to a FIXED dir name (no target-triple suffix). Unlike `externalBin`,
# `bundle.resources` doesn't require a triple suffix — one fixed name works on
# every platform. Dereference symlinks (-L) so the resource tree is fully
# concrete (Tauri's resource walker mishandles symlinks-in-a-framework-tree).
OUT_DIR="$REPO_ROOT/frontend/src-tauri/binaries"
DEST="$OUT_DIR/perfect-pixel-api"
mkdir -p "$OUT_DIR"
rm -rf "$DEST"
cp -RL "$SRC_DIR" "$DEST"
chmod +x "$DEST/perfect-pixel-api"

# Ad-hoc sign every native binary in the bundle with the hardened-runtime +
# an entitlement that disables library validation. Without this, macOS rejects
# the PyInstaller-bundled Python.framework / opencv dylibs ("mapping process
# and mapped file have different Team IDs") and the sidecar aborts on launch.
# Deep-sign the whole directory so every Mach-O is covered.
ENTITLEMENTS="$REPO_ROOT/frontend/src-tauri/Entitlements.plist"
echo ">> Signing native binaries in $DEST"
find "$DEST" -type f \( -name "*.so" -o -name "*.dylib" -o -name "*.pyd" \
  -o -name "Python" -o -perm +111 \) -print0 \
  | while IFS= read -r -d '' f; do
      if file "$f" | grep -q -E 'Mach-O|shared library|executable'; then
        codesign --force --sign - --options runtime --entitlements "$ENTITLEMENTS" "$f" 2>/dev/null || true
      fi
    done
# Deep-sign the bundle root (the main executable) last so the seal is consistent.
codesign --force --sign - --options runtime --entitlements "$ENTITLEMENTS" "$DEST/perfect-pixel-api"

echo ">> Sidecar ready: $DEST"
