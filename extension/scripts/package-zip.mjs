import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");
const distDir = resolve(extDir, "dist");

const pkg = JSON.parse(readFileSync(resolve(extDir, "package.json"), "utf8"));
const zipName = `recall-extension-v${pkg.version}.zip`;
const zipPath = resolve(extDir, zipName);

const requiredFiles = [
  "manifest.json",
  "popup.html",
  "offscreen.html",
  "service_worker.js",
  "content_extract.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "ort/ort-wasm-simd-threaded.wasm",
  "ort/ort-wasm-simd-threaded.mjs",
];

const missing = requiredFiles.filter((rel) => !existsSync(resolve(distDir, rel)));
if (missing.length > 0) {
  throw new Error(`Missing required MV3 dist files: ${missing.join(", ")}`);
}

const assetsDir = resolve(distDir, "assets");
const wasmBundles = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((f) => f.startsWith("recall_wasm_bg") && f.endsWith(".wasm"))
  : [];
if (wasmBundles.length === 0) {
  throw new Error("Missing compiled recall_wasm_bg*.wasm in dist/assets/");
}

const manifest = JSON.parse(readFileSync(resolve(distDir, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) {
  throw new Error(`Expected manifest_version 3, got ${manifest.manifest_version}`);
}
const csp = manifest.content_security_policy?.extension_pages ?? "";
if (!csp.includes("'wasm-unsafe-eval'")) {
  throw new Error("MV3 manifest CSP is missing 'wasm-unsafe-eval'");
}

if (existsSync(zipPath)) {
  rmSync(zipPath, { force: true });
}

if (process.platform === "win32") {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: "inherit" }
  );
} else {
  execFileSync("zip", ["-rq", zipPath, "."], { cwd: distDir, stdio: "inherit" });
}

const mb = (statSync(zipPath).size / (1024 * 1024)).toFixed(2);
console.log(`Verified MV3 bundle and packaged ${zipName} (${mb} MB)`);
