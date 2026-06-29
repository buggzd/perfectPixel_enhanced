// Ensures a placeholder sidecar binary exists at the path Tauri's build script
// expects (frontend/src-tauri/binaries/perfect-pixel-api-<triple>).
//
// `bundle.externalBin` in tauri.conf.json is validated at every build —
// including `tauri dev` — even though dev mode launches the backend via
// `python -m api.run` and never touches the sidecar. We drop a stub file so
// dev builds pass; a real sidecar (from scripts/build_sidecar.sh) is required
// for `tauri build` and is left untouched if already present.
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(__dirname, "..", "src-tauri");

const triple = execSync("rustc -vV", { stdio: ["ignore", "pipe", "ignore"] })
  .toString()
  .match(/host:\s*(\S+)/)?.[1];
if (!triple) {
  console.warn("[ensure-sidecar] could not determine rustc host triple; skipping");
  process.exit(0);
}

const ext = process.platform === "win32" ? ".exe" : "";
const target = join(srcTauri, "binaries", `perfect-pixel-api-${triple}${ext}`);

if (existsSync(target)) {
  // A real (or pre-existing) sidecar is already there — don't clobber it.
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, process.platform === "win32" ? "" : "#!/bin/sh\nexit 0\n");
if (process.platform !== "win32") chmodSync(target, 0o755);
console.log(`[ensure-sidecar] created dev placeholder at ${target}`);
