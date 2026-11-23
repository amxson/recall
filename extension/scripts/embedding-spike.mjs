/**
 * Phase 2 embedding spike: measures real Xenova/all-MiniLM-L6-v2 (q8) download size,
 * cold load time, per-page indexing cost on frozen FastAPI docs, and query latency
 * through the compiled Rust recall-wasm engine.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

import { initSync, WasmRecallIndex, chunk_text_json } from "../src/wasm/recall_wasm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");
const repoRoot = resolve(extDir, "..");

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const SAMPLE_DOCS = [
  "background-tasks.md",
  "cors.md",
  "handling-errors.md",
  "middleware.md",
  "response-model.md",
];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  // Initialize recall-wasm from compiled release .wasm
  const wasmBytes = readFileSync(resolve(extDir, "src", "wasm", "recall_wasm_bg.wasm"));
  initSync({ module: wasmBytes });

  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useFSCache = true;
  env.cacheDir = resolve(repoRoot, "eval", "cache", "hf-models");

  const downloadedFiles = new Map();
  const loadStart = performance.now();
  const extractor = await pipeline("feature-extraction", MODEL_ID, {
    dtype: "q8",
    device: "cpu",
    progress_callback: (info) => {
      if (info && info.file && typeof info.total === "number" && info.total > 0) {
        downloadedFiles.set(info.file, info.total);
      }
    },
  });
  const loadMs = performance.now() - loadStart;

  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, "eval", "corpus_manifest.json"), "utf8")
  );
  const byFile = new Map(manifest.documents.map((d) => [d.filename, d]));

  const index = new WasmRecallIndex(384);
  const pageTimings = [];
  let totalChunks = 0;

  for (const filename of SAMPLE_DOCS) {
    const meta = byFile.get(filename);
    const md = readFileSync(resolve(repoRoot, "eval", "corpus", filename), "utf8");

    const t0 = performance.now();
    const chunksJson = chunk_text_json(md, "heading");
    const chunks = JSON.parse(chunksJson);
    const tChunk = performance.now();

    const texts = chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text));
    const flat = new Float32Array(chunks.length * 384);
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8);
      const out = await extractor(batch, { pooling: "mean", normalize: true });
      flat.set(out.data, i * 384);
    }
    const tEmbed = performance.now();

    index.upsert_document(meta.doc_id, meta.url, meta.title, Date.now(), chunksJson, flat);
    const tUpsert = performance.now();

    totalChunks += chunks.length;
    pageTimings.push({
      doc_id: meta.doc_id,
      words: meta.words,
      chunks: chunks.length,
      chunk_ms: Number((tChunk - t0).toFixed(2)),
      embed_ms: Number((tEmbed - tChunk).toFixed(1)),
      upsert_ms: Number((tUpsert - tEmbed).toFixed(2)),
      total_ms: Number((tUpsert - t0).toFixed(1)),
    });
  }

  const probeQueries = [
    "run work after sending the http response like sending an email",
    "wildcard origin cannot be used with allow credentials",
    "return custom status code and headers on error",
    "intercept every request before and after path operation",
    "filter out hashed password field before returning json",
  ];

  const embedLatencies = [];
  const searchLatencies = [];
  const sampleResults = [];

  for (let round = 0; round < 3; round++) {
    for (const q of probeQueries) {
      const te0 = performance.now();
      const qOut = await extractor(q, { pooling: "mean", normalize: true });
      const te1 = performance.now();
      const hits = JSON.parse(index.search_hybrid_json(q, qOut.data, 3, 60));
      const ts1 = performance.now();

      embedLatencies.push(te1 - te0);
      searchLatencies.push(ts1 - te1);

      if (round === 0) {
        sampleResults.push({
          query: q,
          top_hit: hits[0]?.doc_id ?? null,
          heading: hits[0]?.heading ?? null,
          bm25_rank: hits[0]?.bm25_rank ?? null,
          vector_rank: hits[0]?.vector_rank ?? null,
        });
      }
    }
  }

  const snapshotBytes = Buffer.byteLength(index.to_json(), "utf8");
  const mem = process.memoryUsage();
  const filesSummary = Object.fromEntries(
    [...downloadedFiles.entries()].map(([file, bytes]) => [file, bytes])
  );
  const totalModelBytes = [...downloadedFiles.values()].reduce((a, b) => a + b, 0);

  const report = {
    model: MODEL_ID,
    dtype: "q8",
    backend: "onnxruntime-node (cpu, q8) + recall-wasm",
    model_load_ms: Number(loadMs.toFixed(1)),
    model_files_bytes: filesSummary,
    model_total_mb: Number((totalModelBytes / (1024 * 1024)).toFixed(2)),
    indexed_pages: SAMPLE_DOCS.length,
    indexed_chunks: totalChunks,
    snapshot_kb: Number((snapshotBytes / 1024).toFixed(1)),
    page_timings: pageTimings,
    query_embed_p50_ms: Number(percentile(embedLatencies, 50).toFixed(1)),
    query_embed_p95_ms: Number(percentile(embedLatencies, 95).toFixed(1)),
    wasm_hybrid_search_p50_ms: Number(percentile(searchLatencies, 50).toFixed(3)),
    wasm_hybrid_search_p95_ms: Number(percentile(searchLatencies, 95).toFixed(3)),
    rss_mb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
    heap_used_mb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
    sample_results: sampleResults,
  };

  console.log(JSON.stringify(report, null, 2));
  index.free();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
