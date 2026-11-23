import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");
const repoRoot = resolve(extDir, "..");
const wasmCrateDir = resolve(repoRoot, "crates", "recall-wasm");
const pkgDir = resolve(wasmCrateDir, "pkg");
const outDir = resolve(extDir, "src", "wasm");

const cargoBin = process.env.USERPROFILE
  ? resolve(process.env.USERPROFILE, ".cargo", "bin")
  : process.env.HOME
    ? resolve(process.env.HOME, ".cargo", "bin")
    : "";

const env = {
  ...process.env,
  PATH: cargoBin ? `${cargoBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` : process.env.PATH,
};

const wasmPackBin = process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack";

execFileSync(
  wasmPackBin,
  ["build", wasmCrateDir, "--target", "web", "--release", "--no-opt"],
  { stdio: "inherit", env }
);

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });
cpSync(pkgDir, outDir, { recursive: true });
rmSync(resolve(outDir, ".gitignore"), { force: true });
console.log(`Synced recall-wasm artifacts -> ${outDir}`);

// Bundle onnxruntime-web WASM/MJS runtime files locally so MV3 CSP never needs remote script loads.
const ortSrcDir = resolve(extDir, "node_modules", "onnxruntime-web", "dist");
const ortOutDir = resolve(extDir, "public", "ort");
const ortFiles = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];
if (existsSync(ortSrcDir)) {
  mkdirSync(ortOutDir, { recursive: true });
  for (const name of ortFiles) {
    const src = resolve(ortSrcDir, name);
    if (existsSync(src)) {
      cpSync(src, resolve(ortOutDir, name));
    }
  }
  console.log(`Synced onnxruntime-web WASM assets -> ${ortOutDir}`);
}
