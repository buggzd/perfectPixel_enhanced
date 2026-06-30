// Ensures a placeholder sidecar directory exists at the path Tauri's build
// expects (frontend/src-tauri/binaries/perfect-pixel-api/).
//
// `bundle.resources` (map form) is validated at every build — including
// `tauri dev` — even though dev mode launches the backend via
// `python -m api.run` and never touches the sidecar. We drop a stub directory
// (with a tiny placeholder executable inside) so dev builds pass; a real
// sidecar (from scripts/build_sidecar.sh / .ps1) is required for `tauri build`
// and is left untouched if already present.
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(__dirname, "..", "src-tauri");

const ext = process.platform === "win32" ? ".exe" : "";
const dir = join(srcTauri, "binaries", "perfect-pixel-api");
const target = join(dir, `perfect-pixel-api${ext}`);

if (existsSync(target)) {
  // A real (or pre-existing) sidecar is already there — don't clobber it.
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
writeFileSync(target, process.platform === "win32" ? "" : "#!/bin/sh\nexit 0\n");
if (process.platform !== "win32") chmodSync(target, 0o755);
console.log(`[ensure-sidecar] created dev placeholder at ${target}`);
