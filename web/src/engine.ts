import initWasm, { WasmRecallIndex } from "./wasm/recall_wasm";
import type { BenchmarkBundle, DemoPreset, IndexStats, SearchHit, SearchMode } from "./types";

type EmbedderFn = (
  input: string,
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let embedderPromise: Promise<EmbedderFn> | null = null;

async function getBrowserEmbedder(
  onProgress?: (pct: number) => void
): Promise<EmbedderFn> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      env.useBrowserCache = typeof caches !== "undefined";
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      const create = pipeline as unknown as (
        task: string,
        model: string,
        opts: Record<string, unknown>
      ) => Promise<EmbedderFn>;
      return create("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "q8",
        device: "wasm",
        progress_callback: (info: { progress?: number }) => {
          if (typeof info?.progress === "number") {
            onProgress?.(Math.round(info.progress));
          }
        },
      });
    })().catch((err) => {
      embedderPromise = null;
      throw err;
    });
  }
  return embedderPromise;
}

export interface DemoEngineHandle {
  index: WasmRecallIndex;
  stats: IndexStats;
  presets: DemoPreset[];
  benchmarks: BenchmarkBundle;
  loadMs: number;
}

export async function loadDemoEngine(): Promise<DemoEngineHandle> {
  const t0 = performance.now();
  const [, snapRes, presetsRes, benchRes] = await Promise.all([
    initWasm(),
    fetch("/data/fastapi-index.json"),
    fetch("/data/demo-presets.json"),
    fetch("/data/benchmarks.json"),
  ]);

  if (!snapRes.ok || !presetsRes.ok || !benchRes.ok) {
    throw new Error("Failed to load pre-indexed FastAPI demo bundle.");
  }

  const [snapshotJson, presets, benchmarks] = await Promise.all([
    snapRes.text(),
    presetsRes.json() as Promise<DemoPreset[]>,
    benchRes.json() as Promise<BenchmarkBundle>,
  ]);

  const index = WasmRecallIndex.from_json(snapshotJson);
  const stats = JSON.parse(index.stats_json()) as IndexStats;

  return {
    index,
    stats,
    presets,
    benchmarks,
    loadMs: performance.now() - t0,
  };
}

export async function runDemoSearch(
  handle: DemoEngineHandle,
  query: string,
  mode: SearchMode,
  topK: number = 8,
  onModelProgress?: (pct: number) => void
): Promise<{
  hits: SearchHit[];
  embedMs: number;
  searchMs: number;
  usedPresetVector: boolean;
}> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { hits: [], embedMs: 0, searchMs: 0, usedPresetVector: false };
  }

  if (mode === "keyword") {
    const t0 = performance.now();
    const hits = JSON.parse(handle.index.search_keyword_json(trimmed, topK)) as SearchHit[];
    return { hits, embedMs: 0, searchMs: performance.now() - t0, usedPresetVector: false };
  }

  const matchedPreset = handle.presets.find(
    (p) => p.query.trim().toLowerCase() === trimmed.toLowerCase()
  );

  let queryVec: Float32Array;
  let embedMs = 0;
  let usedPresetVector = false;

  if (matchedPreset) {
    queryVec = new Float32Array(matchedPreset.embedding);
    usedPresetVector = true;
  } else {
    const tEmbed = performance.now();
    const embedder = await getBrowserEmbedder(onModelProgress);
    const out = await embedder(trimmed, { pooling: "mean", normalize: true });
    queryVec = new Float32Array(out.data);
    embedMs = performance.now() - tEmbed;
  }

  const tSearch = performance.now();
  const raw =
    mode === "semantic"
      ? handle.index.search_semantic_json(queryVec, topK)
      : handle.index.search_hybrid_json(trimmed, queryVec, topK, 60);
  const searchMs = performance.now() - tSearch;

  return {
    hits: JSON.parse(raw) as SearchHit[],
    embedMs,
    searchMs,
    usedPresetVector,
  };
}
