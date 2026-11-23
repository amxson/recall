# Recall

Local-first hybrid search for pages you have read. Save a documentation page or article in Chrome, search it later from memory using keywords or rough concepts, and jump straight back to the highlighted passage on the original page.

No server, no account, and no page content leaving the browser. The search engine is written in Rust, compiled to WebAssembly, and paired with local embeddings in an MV3 extension and a browser demo.

<!-- Demo GIF placeholder: add 60s capture once the MV3 extension and web demo are wired up -->

## Why

Browser history only matches page titles and URLs. Bookmarks pile up without searching the actual text inside them. If you remember *reading* an explanation of dependency overrides or background tasks last week—but not the title or exact wording—standard history search misses it.

Recall indexes saved passages locally and combines:
- **BM25** for exact identifiers, flags, error codes, and technical terms
- **Brute-force L2-normalized cosine similarity** over dense embeddings for paraphrased or conceptual queries
- **Reciprocal Rank Fusion (RRF, `k = 60`)** to merge both rankings without tuning fragile score weights

Brute-force cosine is intentional here: for a personal reading index of a few thousand passages, a contiguous `f32` dot product is fast, deterministic, easy to serialize into IndexedDB, and avoids the memory and deletion overhead of an approximate graph index (HNSW).

## Architecture

```text
crates/
  recall-core/   # Tokenizer, chunkers, BM25, cosine vector store, RRF fusion, snapshots
  recall-cli/    # Native terminal indexer and search runner for local testing & eval
  recall-wasm/   # wasm-bindgen bindings compiled via wasm-pack for Chrome & web demo
eval/            # Frozen docs corpus manifest, hand-written queries, and benchmark runner
extension/       # Chrome MV3 extension (activeTab save, offscreen WASM + embeddings, IndexedDB)
web/             # Public zero-install demo with pre-indexed corpus and benchmark views
```

## Benchmarks

Benchmarks will be run against a frozen snapshot of the FastAPI tutorial documentation using hand-written queries written prior to ranking adjustments.

| Method | Chunker | Recall@5 | MRR@10 | NDCG@10 | p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| BM25 | Fixed | TBD | TBD | TBD | TBD | TBD |
| Vector | Fixed | TBD | TBD | TBD | TBD | TBD |
| Hybrid (RRF) | Heading-aware | TBD | TBD | TBD | TBD | TBD |
| Hybrid (RRF) | Sentence-window | TBD | TBD | TBD | TBD | TBD |

*Status: pending corpus freeze, query authoring, and evaluation runs.*

## Installing the Unpacked Chrome Extension

```bash
cd extension
npm ci --ignore-scripts
npm run build
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select `extension/dist`.
3. Open any documentation page or article, press `Alt+K` (or click the Recall toolbar icon), and click **Save this page**.

See [docs/embedding-spike.md](docs/embedding-spike.md) for measured `all-MiniLM-L6-v2` (`q8`) download size, per-page indexing timings, and MV3 offscreen/CSP notes.

## Development

```bash
# Run Rust tests across the workspace
cargo test --workspace

# Run microbenchmarks
cargo bench -p recall-core

# Build the WebAssembly package
wasm-pack build crates/recall-wasm --target web --release

# Typecheck, test, and build the Chrome extension
cd extension && npm run build && npm run typecheck && npm test
```

## Limitations (v0.1 scope)

- Click-to-save only (`activeTab`); does not passively scrape browsing history.
- Focused on readable documentation pages and articles; PDFs, login-walled apps, and heavy canvas SPAs are out of scope for v0.1.
- Brute-force cosine targets personal reading scale (up to ~10k–20k passages), not web-scale corpora.
