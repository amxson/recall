import { env, pipeline } from "@huggingface/transformers";

import { EMBEDDING_DIM } from "../shared/wasm";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

export interface EmbedderProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface BatchEmbedResult {
  flat: Float32Array;
  dim: number;
  elapsedMs: number;
}

export type TextEmbedderFn = (
  input: string | string[],
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let extractorPromise: Promise<TextEmbedderFn> | null = null;
let configured = false;
let progressListener: ((event: EmbedderProgress) => void) | null = null;
let inferenceQueue = Promise.resolve();

async function runInference(input: string | string[]): Promise<Float32Array> {
  const extractor = await getEmbedder();
  const result = inferenceQueue.then(async () => {
    // Let the worker receive search and status messages between CPU-bound batches.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return (await extractor(input, { pooling: "mean", normalize: true })).data;
  });
  inferenceQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function setEmbedderProgressListener(
  listener: ((event: EmbedderProgress) => void) | null
): void {
  progressListener = listener;
}

export function configureTransformersForMv3(): void {
  if (configured) return;
  configured = true;

  env.allowLocalModels = false;
  env.useBrowserCache = typeof caches !== "undefined";

  const wasmCfg = env.backends?.onnx?.wasm;
  if (wasmCfg) {
    // MV3 offscreen documents do not have cross-origin isolation for SharedArrayBuffer threads.
    wasmCfg.numThreads = 1;
    wasmCfg.proxy = false;

    if (typeof location !== "undefined" && location.protocol === "chrome-extension:") {
      wasmCfg.wasmPaths = new URL("/ort/", location.href).href;
    }
  }
}

export function getEmbedder(
  onProgress?: (event: EmbedderProgress) => void
): Promise<TextEmbedderFn> {
  if (!extractorPromise) {
    configureTransformersForMv3();
    const createPipeline = pipeline as unknown as (
      task: string,
      model: string,
      options: Record<string, unknown>
    ) => Promise<TextEmbedderFn>;
    extractorPromise = createPipeline("feature-extraction", MODEL_ID, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (event: EmbedderProgress) => {
        onProgress?.(event);
        progressListener?.(event);
      },
    }).catch((err) => {
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

export async function embedText(text: string): Promise<Float32Array> {
  const data = await runInference(text);
  return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

export async function embedBatch(
  texts: string[],
  batchSize: number = 8
): Promise<BatchEmbedResult> {
  if (texts.length === 0) {
    return { flat: new Float32Array(0), dim: EMBEDDING_DIM, elapsedMs: 0 };
  }

  const started = performance.now();
  const vectors: Float32Array[] = [];
  const step = Math.max(1, batchSize);

  for (let i = 0; i < texts.length; i += step) {
    const slice = texts.slice(i, i + step);
    const raw = await runInference(slice);
    const count = slice.length;
    const dim = raw.length / count;

    for (let j = 0; j < count; j++) {
      const start = j * dim;
      vectors.push(new Float32Array(raw.subarray(start, start + dim)));
    }
  }

  const dim = vectors[0]?.length ?? EMBEDDING_DIM;
  const flat = packEmbeddings(vectors, dim);
  return { flat, dim, elapsedMs: performance.now() - started };
}

export function packEmbeddings(vectors: Float32Array[], dim: number): Float32Array {
  const flat = new Float32Array(vectors.length * dim);
  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];
    if (vec.length !== dim) {
      throw new Error(`embedding length mismatch at index ${i}: expected ${dim}, got ${vec.length}`);
    }
    flat.set(vec, i * dim);
  }
  return flat;
}
