# Build the Perfect Pixel Python backend as a single PyInstaller executable and
# place it where Tauri expects its sidecar (named with the Rust target triple).
#
#   frontend\src-tauri\binaries\perfect-pixel-api-<triple>.exe
#
# Run from an elevated/normal PowerShell after `rustc` is on PATH.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir
$Venv      = Join-Path $RepoRoot ".venv"
$VenvPy    = Join-Path $Venv "Scripts\python.exe"

if (Test-Path $VenvPy) {
    $Py = $VenvPy
} else {
    Write-Host ">> .venv not found; creating one with python"
    python -m venv $Venv
    $Py = $VenvPy
}

Write-Host ">> Installing dependencies + pyinstaller"
& $Py -m pip install --upgrade pip | Out-Null
& $Py -m pip install -r (Join-Path $RepoRoot "requirements.txt") pyinstaller | Out-Null

Write-Host ">> Building sidecar executable"
Push-Location $RepoRoot
& $Py -m PyInstaller scripts\perfect_pixel_api.spec `
    --noconfirm `
    --distpath build\sidecar `
    --workpath build\pyi `
    --clean
Pop-Location

# Resolve the Rust host target triple (e.g. x86_64-pc-windows-msvc).
$triple = (rustc -vV | Select-String "^host:").ToString().Split(":")[1].Trim()
if ([string]::IsNullOrWhiteSpace($triple)) {
    throw "Could not determine rustc host triple. Is rustc installed?"
}

$OutDir = Join-Path $RepoRoot "frontend\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Out = Join-Path $OutDir "perfect-pixel-api-$triple.exe"

Copy-Item -Path (Join-Path $RepoRoot "build\sidecar\perfect-pixel-api.exe") -Destination $Out -Force

Write-Host ">> Sidecar ready: $Out"
