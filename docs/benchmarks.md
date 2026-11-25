# Retrieval & Latency Benchmarks

All retrieval accuracy numbers below were measured against a frozen snapshot of the FastAPI tutorial documentation using 50 queries authored and committed (`eval/queries.jsonl`) **before** writing or running the benchmark harness (`eval/run_benchmark.mjs`). No tokenizer rules, chunk sizes, or RRF constants were tuned after seeing results.

## Test Environment & Corpus

- **Corpus:** `fastapi/fastapi` `docs/en/docs/tutorial/*.md`, pinned at `v0.165.0` (`05e6df7e906c3decba377c37548019973f40bf15`) — **40 pages, 32,824 words**
- **Queries:** 50 queries (`13` exact, `15` conceptual, `12` mixed, `10` hard) in [eval/queries.jsonl](../eval/queries.jsonl)
- **Embedding model:** `Xenova/all-MiniLM-L6-v2` (384-dim, quantized `q8` ONNX, mean pooling + L2 norm)
- **Search engine:** Compiled Rust `recall-wasm` (`Okapi BM25 k1=1.5, b=0.75`, brute-force L2 cosine, `RRF k=60`)
- **Host machine:** Windows x64, 11th Gen Intel Core i7-1165G7 @ 2.80GHz, Node v26.13.0
- **Scoring protocol:** Max-P passage-to-document ranking (first/highest-scoring passage per `doc_id` determines document rank for `R@1`, `R@5`, `MRR@10`, `NDCG@10`). Raw machine-generated output is checked in at [eval/results/benchmark_results.json](../eval/results/benchmark_results.json).

Reproduce locally:

```bash
python eval/fetch_corpus.py
node eval/run_benchmark.mjs
```

---

## Retrieval Accuracy & WASM Query Latency (All 9 Configurations)

*Latency measures `recall-wasm` index search only (3 passes × 50 queries after 5 warmup queries; excludes the ~10.7 ms single-query MiniLM embedding step measured in [docs/embedding-spike.md](embedding-spike.md)).*

| Method | Chunker | Chunks | R@1 | R@5 | MRR@10 | NDCG@10 | p50 (ms) | p95 (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BM25 | Fixed (140w / 25w overlap) | 298 | 80.0% | 100.0% | 0.893 | 0.921 | 0.134 | 0.345 |
| Vector | Fixed (140w / 25w overlap) | 298 | 90.0% | 100.0% | 0.942 | 0.957 | 0.225 | 0.325 |
| **Hybrid (RRF)** | **Fixed (140w / 25w overlap)** | **298** | **94.0%** | **100.0%** | **0.970** | **0.978** | **0.282** | **0.437** |
| BM25 | Heading-aware (max 180w) | 430 | 78.0% | 100.0% | 0.872 | 0.905 | 0.118 | 0.180 |
| Vector | Heading-aware (max 180w) | 430 | 82.0% | 100.0% | 0.891 | 0.918 | 0.315 | 0.608 |
| **Hybrid (RRF)** | **Heading-aware (max 180w)** | **430** | **88.0%** | **100.0%** | **0.937** | **0.953** | **0.368** | **0.717** |
| BM25 | Sentence-window (4s / 1s) | 690 | 80.0% | 100.0% | 0.882 | 0.912 | 0.177 | 0.270 |
| Vector | Sentence-window (4s / 1s) | 690 | 78.0% | 98.0% | 0.859 | 0.889 | 0.507 | 0.703 |
| **Hybrid (RRF)** | **Sentence-window (4s / 1s)** | **690** | **84.0%** | **100.0%** | **0.903** | **0.928** | **0.536** | **0.734** |

### Per-Category MRR@10 Breakdown

| Configuration | Exact (n=13) | Conceptual (n=15) | Mixed (n=12) | Hard (n=10) |
| --- | ---: | ---: | ---: | ---: |
| Fixed — BM25 | 0.962 | 0.889 | 0.903 | 0.800 |
| Fixed — Vector | 0.949 | 0.917 | 0.917 | 1.000 |
| **Fixed — Hybrid (RRF)** | **0.962** | **0.967** | **1.000** | **0.950** |
| Heading — BM25 | 0.949 | 0.839 | 0.875 | 0.820 |
| Heading — Vector | 0.962 | 0.769 | 0.917 | 0.950 |
| **Heading — Hybrid (RRF)** | **1.000** | **0.856** | **0.958** | **0.950** |

---

## Key Findings

### 1. Hybrid RRF consistently beat single retrievers—but did not win every query
On every chunking strategy, `Hybrid (RRF, k=60)` improved `R@1`, `MRR@10`, and `NDCG@10` over both BM25 and Vector alone (`+14 pts` R@1 over BM25 and `+4 pts` over Vector on `fixed`; `+10 pts` / `+6 pts` on `heading`).

Looking at query-by-query MRR@10 on `heading-aware`:
- **Hybrid vs. BM25:** Hybrid won **7** queries, tied **41**, and lost **2** (`q22`, `q26`).
- **Hybrid vs. Vector:** Hybrid won **7** queries, tied **41**, and lost **2** (`q38`, `q49`).

### 2. Fixed-size chunking outperformed heading-aware and sentence-window on ranking
Contrary to the usual assumption that structure-aware chunking always wins, `fixed-size` (140 words, 298 chunks) beat both `heading-aware` (430 chunks, `MRR 0.970` vs `0.937`) and `sentence-window` (690 chunks, `MRR 0.903`).

The gap is clearest in `conceptual` Vector search (`0.917` MRR on `fixed` vs. `0.769` on `heading`):
- FastAPI tutorial pages contain many short 1–2 sentence sub-sections (`Recap`, `Check the Docs`, `Technical Details`, `Alternative`). Splitting strictly on every heading produces short, context-thin passages that give MiniLM weaker semantic signal.
- `sentence-window` (4 sentences) fragmented the corpus even further (`690` chunks), causing the only `R@5` miss in the entire matrix (`q25` under Vector-only).
- **UI vs. retrieval trade-off:** `heading-aware` produces cleaner section breadcrumbs and jump-back anchors in the Chrome extension, while `fixed` wins raw retrieval accuracy. Merging consecutive short heading blocks below a minimum ~75-word floor is a natural next improvement (intentionally left un-tuned here to avoid overfitting to this 50-query set).

---

## Failure Analysis

### Where BM25 beat Vector
- **`q01` (`exact`):** `"jsonable_encoder convert pydantic model to json compatible dict"` — BM25 ranked `encoder` **#1** on the exact identifier `jsonable_encoder`, while Vector ranked `first-steps` #1 and `encoder` **#2**. Hybrid recovered **#1**.
- **`q21` (`conceptual`):** `"run app directly from python script to hit breakpoints in editor"` — BM25 nailed `debugging` **#1** via the rare token `breakpoints`; Vector drifted to `first-steps` (#1) and dropped `debugging` to **#4**. Hybrid recovered **#1**.
- **`q25` (`conceptual`):** `"mark an older api route as deprecated in generated documentation"` — BM25 ranked `path-operation-configuration` **#1** via `deprecated`; Vector fell to **#5** on `heading` and **missed Top-5 completely** on `sentence` (pulled into `bigger-applications` and `metadata` by generic "api route / documentation" phrasing). Hybrid rescued it to **#1** on `heading` and **#2** on `fixed`.

### Where Vector beat BM25
- **`q23` (`conceptual`):** `"send newline delimited json objects incrementally as they are generated"` — Never mentions `"JSON Lines"` or `"stream"`. BM25 ranked `body-nested-models` #1 on `"json"` + `"objects"` and pushed `stream-json-lines` to **#4**; Vector ranked `stream-json-lines` **#1**, and Hybrid kept it at **#1**.
- **`q43` (`hard`):** `"parameter ordering trick in python when non-default path param follows default query param"` — BM25 ranked `query-param-models` #1 and dropped `path-params-numeric-validations` to **#5**; Vector nailed **#1**, and Hybrid kept **#1**.
- **`q17` (`conceptual`):** `"intercept every incoming request and outgoing response globally to time it"` — Never uses the word `"middleware"`. BM25 ranked `cors` #1 (`middleware` #2); Vector ranked `middleware` **#1**, and Hybrid kept **#1**.

### Where Hybrid RRF lost to a single retriever
- **`q22` (`conceptual`, heading):** `"push one way live updates from server to browser over http connection"` — BM25 had `server-sent-events` at **#1**, while Vector ranked `body-updates` #1 (anchored on `"updates"`) and `server-sent-events` #2. Because `cors` appeared mid-pack in *both* lists (`browser`, `http`, `server`), equal-weight RRF promoted `cors` to **#1** and pushed `server-sent-events` to **#2**.
- **`q38` (`mixed`, heading):** `"read browser cookie values with Cookie parameter"` — Vector ranked `cookie-params` **#1**, but BM25 preferred the longer `cookie-param-models` page (#1), so RRF ranked `cookie-param-models` #1 and `cookie-params` **#2**.
- **`q26` (`conceptual`, heading):** `"show realistic sample payload values inside swagger interactive docs"` — Ranked `schema-extra-example` **#3** behind `first-steps` and `path-params` because both introductory pages heavily discuss Swagger / interactive docs.

---

## Native Rust Microbenchmarks (`criterion`)

Measured with `cargo bench -p recall-core --bench search_bench` (release LTO build, 384-dim L2-normalized vectors, same i7-1165G7 host) to verify how brute-force contiguous cosine scales up to personal reading limits:

| Passages | BM25 | Brute-Force Cosine (384d) | Hybrid (RRF) |
| ---: | ---: | ---: | ---: |
| 500 | 124 µs | 419 µs | 534 µs |
| 2,000 | 314 µs | 1.36 ms | 1.77 ms |
| 5,000 | 419 µs | 2.65 ms | 3.93 ms |

Even at 5,000 indexed passages (~500 saved documentation pages), exact brute-force cosine + BM25 + RRF completes in under `4 ms` natively with deterministic results and O(1) swap-remove deletions—making HNSW unnecessary for v0.1.

## Benchmark Limitations

- **Corpus size (40 pages):** High `R@5` (`98%–100%`) reflects a focused 40-page single-framework corpus; `R@1` and `MRR@10` are the discriminating signals here. A larger multi-domain corpus of 500+ saved web pages will produce harder false positives and lower absolute recall.
- **Document-level labels:** Queries are scored at the document (`doc_id`) level rather than exact character-span level, though jump-back anchors are inspected qualitatively.
- **Zero-cost single-model baseline:** Only `Xenova/all-MiniLM-L6-v2` (`q8`) was benchmarked because larger 768-dim models exceed comfortable browser download/RAM budgets for an MV3 extension.
