# Local Embedding & MV3 Spike Report

Before building full UI features, we ran a focused embedding spike to verify model footprint, indexing speed per page, query latency, memory overhead, and Chrome MV3 constraints.

## Setup

- **Model:** `Xenova/all-MiniLM-L6-v2` (384-dim, quantized `q8` ONNX)
- **Retrieval engine:** Compiled `recall-wasm` (`335 KB` raw / `118 KB` gzip)
- **Sample corpus:** 5 pages from the frozen FastAPI `v0.165.0` docs (`59` heading-aware passages total)
- **Script:** `node extension/scripts/embedding-spike.mjs`
- **Host:** Windows x86_64, Node v26.13, `onnxruntime-node` (`cpu`, `q8`) + `recall-wasm`

## Measured Results

| Metric | Measured Value | Notes |
| --- | --- | --- |
| Model download size | **22.59 MB** | `onnx/model_quantized.onnx` (22.97 MB) + `tokenizer.json` (711 KB) |
| Cold load (incl. network download) | **51.1 s** | First-time fetch over HTTPS; cached locally thereafter |
| Warm load (from local cache) | **555.3 ms** | Loaded once per offscreen document session |
| Query embedding latency | **10.7 ms p50 / 12.7 ms p95** | 15 runs across 5 probe queries |
| WASM hybrid search (59 passages) | **0.47 ms p50** | Matches native `criterion` baseline (`0.53 ms` at 500 passages) |
| Snapshot size (59 passages + 384d) | **344.6 KB** | ~5.8 KB per indexed passage (JSON snapshot in IndexedDB) |
| Process RSS (Node spike) | **311.4 MB** | `18.0 MB` JS heap; remainder is ONNX runtime + model buffers |

### Per-Page Indexing Breakdown

| Page | Words | Chunks | Chunking | Embedding | WASM Upsert | Total |
| --- | --- | --- | --- | --- | --- | --- |
| `middleware.md` | 508 | 5 | 0.58 ms | 420.8 ms | 0.93 ms | **422.3 ms** |
| `background-tasks.md` | 666 | 8 | 3.58 ms | 613.7 ms | 16.31 ms | **633.6 ms** |
| `cors.md` | 696 | 9 | 1.15 ms | 1,268.5 ms | 1.69 ms | **1,271.3 ms** |
| `handling-errors.md` | 1,215 | 12 | 1.25 ms | 973.0 ms | 3.63 ms | **977.9 ms** |
| `response-model.md` | 2,232 | 25 | 1.74 ms | 1,866.0 ms | 5.00 ms | **1,872.7 ms** |

**Takeaway:** Chunking and Rust/WASM indexing are negligible (`<20 ms` per page). Embedding accounts for >98% of save latency (~45–75 ms per chunk), which stays under 2 seconds even for a 2,200-word documentation page.

## MV3 Compatibility Findings

1. **Offscreen document required:** MV3 service workers terminate after idle periods and cannot reliably hold loaded ONNX/WASM state. Hosting `WasmRecallIndex` and `@huggingface/transformers` inside `offscreen.html` with IndexedDB snapshot persistence keeps state durable across worker restarts.
2. **CSP and local `ort-wasm` bundling:** Chrome MV3 forbids remote script execution and requires `'wasm-unsafe-eval'` in `manifest.json`. `onnxruntime-web` defaults to loading `.wasm`/`.mjs` glue from a CDN, which MV3 blocks. `extension/scripts/build-wasm.mjs` copies `ort-wasm-simd-threaded*.{mjs,wasm}` into `dist/ort/` and configures `wasmPaths = chrome.runtime.getURL("ort/")`.
3. **Single-threaded WASM (`numThreads = 1`, `proxy = false`):** Offscreen documents lack `COOP`/`COEP` headers for `SharedArrayBuffer`, so disabling WASM threads avoids worker startup failures.
4. **Keyword mode fast path:** `mode: "keyword"` bypasses model loading/inference completely (`embed_ms = 0`), giving sub-millisecond search even before the embedding model finishes warming up.
