import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname, "..");
const repoRoot = resolve(webDir, "..");

// 1. Build recall-wasm and sync into web/src/wasm
const wasmCrateDir = resolve(repoRoot, "crates", "recall-wasm");
const wasmPkgDir = resolve(wasmCrateDir, "pkg");
const wasmOutDir = resolve(webDir, "src", "wasm");

const cargoBin = process.env.USERPROFILE
  ? resolve(process.env.USERPROFILE, ".cargo", "bin")
  : process.env.HOME
    ? resolve(process.env.HOME, ".cargo", "bin")
    : "";

const env = {
  ...process.env,
  PATH: cargoBin
    ? `${cargoBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
    : process.env.PATH,
};

const wasmPackBin = process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack";
execFileSync(wasmPackBin, ["build", wasmCrateDir, "--target", "web", "--release", "--no-opt"], {
  stdio: "inherit",
  env,
});

if (existsSync(wasmOutDir)) {
  rmSync(wasmOutDir, { recursive: true, force: true });
}
mkdirSync(wasmOutDir, { recursive: true });
cpSync(wasmPkgDir, wasmOutDir, { recursive: true });
rmSync(resolve(wasmOutDir, ".gitignore"), { force: true });

// 2. Sync pre-indexed 40-doc FastAPI snapshot, presets, and compact benchmark summary
const dataOutDir = resolve(webDir, "public", "data");
mkdirSync(dataOutDir, { recursive: true });

const snapshotSrc = resolve(repoRoot, "eval", "cache", "fastapi-heading-snapshot.json");
const presetsSrc = resolve(repoRoot, "eval", "cache", "demo-presets.json");
const benchSrc = resolve(repoRoot, "eval", "results", "benchmark_results.json");

if (existsSync(snapshotSrc)) {
  cpSync(snapshotSrc, resolve(dataOutDir, "fastapi-index.json"));
}
if (existsSync(presetsSrc)) {
  cpSync(presetsSrc, resolve(dataOutDir, "demo-presets.json"));
}
if (existsSync(benchSrc)) {
  const full = JSON.parse(readFileSync(benchSrc, "utf8"));
  const compact = {
    generated_at: full.generated_at,
    corpus: full.corpus,
    queries: full.queries,
    environment: full.environment,
    summary_table: full.summary_table,
    head_to_head_heading: full.head_to_head_heading,
    criterion_native: [
      { passages: 500, bm25_ms: 0.124, cosine_ms: 0.419, hybrid_ms: 0.534 },
      { passages: 2000, bm25_ms: 0.314, cosine_ms: 1.363, hybrid_ms: 1.765 },
      { passages: 5000, bm25_ms: 0.419, cosine_ms: 2.655, hybrid_ms: 3.926 },
    ],
  };
  writeFileSync(
    resolve(dataOutDir, "benchmarks.json"),
    JSON.stringify(compact, null, 2) + "\n",
    "utf8"
  );
}

console.log("Synced recall-wasm and demo data assets into web/");
