#!/usr/bin/env python3
"""Sync the project version to a given value across all release manifests.

Usage:
    python scripts/set_version.py 0.1.6
    python scripts/set_version.py v0.1.6   # leading 'v' is stripped

Patches:
  - pyproject.toml                          (Python package version → wheel name)
  - frontend/src-tauri/tauri.conf.json      (Tauri bundle version → installer filename)
  - frontend/src-tauri/Cargo.toml           (Rust crate version)

The CI release workflow calls this with the git tag name so every build
artifact (wheel, .dmg, .exe, .msi) carries the tag's version instead of a
hardcoded constant.
"""
import json
import re
import sys
from pathlib import Path


def set_pyproject(root: Path, v: str) -> None:
    p = root / "pyproject.toml"
    s = p.read_text()
    s2, n = re.subn(r'^version\s*=\s*"[^"]*"', f'version = "{v}"', s, count=1, flags=re.M)
    if n != 1:
        raise SystemExit(f"could not patch version in {p}")
    p.write_text(s2)


def set_tauri_conf(root: Path, v: str) -> None:
    p = root / "frontend" / "src-tauri" / "tauri.conf.json"
    conf = json.loads(p.read_text())
    conf["version"] = v
    p.write_text(json.dumps(conf, indent=2) + "\n")


def set_cargo(root: Path, v: str) -> None:
    p = root / "frontend" / "src-tauri" / "Cargo.toml"
    s = p.read_text()
    # Only the [package] version (line-start); dependency versions are inline
    # inside `{ ... }` and not at line start, so they are untouched.
    s2, n = re.subn(r'^version\s*=\s*"[^"]*"', f'version = "{v}"', s, count=1, flags=re.M)
    if n != 1:
        raise SystemExit(f"could not patch version in {p}")
    p.write_text(s2)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: set_version.py <version>  (e.g. 0.1.6 or v0.1.6)")
    v = sys.argv[1].lstrip("v")
    root = Path(__file__).resolve().parent.parent
    set_pyproject(root, v)
    set_tauri_conf(root, v)
    set_cargo(root, v)
    print(f"version set to {v} in pyproject.toml, tauri.conf.json, Cargo.toml")


if __name__ == "__main__":
    main()
