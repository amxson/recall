# Recall — Chrome Web Store Listing & Submission Guide

Ready-to-paste copy and review answers for submitting `recall-extension-v0.1.0.zip` on the Chrome Web Store Developer Dashboard.

## Store Listing Fields

- **Name:** Recall
- **Summary (≤ 132 chars):**
  > Local-first hybrid search for pages you have read. Save docs or articles and jump back to highlighted passages—100% in Chrome.
- **Category:** Productivity
- **Language:** English
- **Homepage URL:** `https://github.com/amxson/recall`
- **Privacy Policy URL:** `https://github.com/amxson/recall/blob/main/PRIVACY.md`
- **Support URL:** `https://github.com/amxson/recall/issues`

### Detailed Description

Recall adds local-first hybrid search for documentation pages and articles you explicitly save in Chrome—with no server, no account, and no page content leaving your browser.

Standard browser history only matches page titles and URLs. If you remember reading an explanation of dependency overrides, middleware, or CORS last week—but not the exact title—Recall finds the exact passage and jumps straight back to it highlighted on the original page.

**How it works**
- **Click-to-save (`Alt+K`):** Save only the pages you want via `activeTab`. No passive history scraping.
- **Hybrid retrieval in Rust → WebAssembly:** Combines identifier-splitting Okapi BM25 for exact symbols/flags, brute-force L2-normalized cosine similarity over on-device `all-MiniLM-L6-v2` (`q8`) embeddings for conceptual queries, and Reciprocal Rank Fusion (`k = 60`).
- **Offline-resilient two-phase indexing:** Text is chunked and saved to IndexedDB immediately so keyword search works right away even while offline; semantic vectors compute in a background offscreen Web Worker without blocking the popup.
- **Passage jump-back:** Pressing Enter or clicking a hit opens the original page scrolled and highlighted directly to the matched passage (`#:~:text=` with a DOM fallback).

**Privacy**
- 100% local IndexedDB storage on your device.
- Zero telemetry, analytics, ads, or remote API calls.
- One-time download of open-source `Xenova/all-MiniLM-L6-v2` (`q8`, ~22.6 MB) weights from Hugging Face, cached locally for offline use.

## Privacy Practices Tab (Reviewer Form)

### Single Purpose Description
> Save readable text from web pages that the user explicitly clicks to index, run local hybrid keyword and semantic search across those saved passages in the browser, and jump back to the highlighted passage on the original page.

### Permission Justifications
- **`activeTab`**: Grants temporary read access to the current tab only when the user clicks "Save this page" in the Recall popup. Avoids requesting `<all_urls>` or reading browsing history.
- **`scripting`**: Injects the bundled Mozilla Readability text extractor (`content_extract.js`) into the active tab when the user clicks "Save this page", and injects a fallback inline highlight helper when opening a matched result whose phrase spans inline HTML tags.
- **`offscreen`**: Runs the compiled Rust/WebAssembly hybrid search engine and the local ONNX Web Worker embedding runtime persistently outside the ephemeral MV3 service worker lifecycle so indexing continues cleanly if the popup closes.
- **`storage`**: Stores the user's preferred chunking mode (`heading`, `fixed`, or `sentence`) in `chrome.storage.local`.
- **Host permissions:** None requested.
- **Remote code:** No. All JavaScript and WebAssembly runtimes (`recall_wasm_bg.wasm` and `ort-wasm-simd-threaded*.wasm/.mjs`) are bundled directly inside the extension package. Only static binary model weights (`model_quantized.onnx` and JSON tokenizer configs) are fetched once from Hugging Face and cached locally.

### User Data Disclosures
- **Website content:** Checked — readable text and titles of pages the user explicitly chooses to save are processed and stored locally in IndexedDB only. Never transmitted off-device.
- **Limited Use Certification:** Check all three Chrome Web Store Limited Use attestations (data is not sold to third parties, not used/transferred for purposes unrelated to the extension's single purpose, and not used for creditworthiness/lending).

## Pre-Upload Checklist

1. Build and verify the clean package from `extension/`:
   ```bash
   cd extension
   npm ci --ignore-scripts
   npm run typecheck
   npm test
   npm run package
   ```
2. Upload `extension/recall-extension-v0.1.0.zip` to the Chrome Web Store Developer Dashboard.
3. Attach store screenshots (`1280×800` or `640×400`) and the `128×128` icon (`extension/public/icons/icon-128.png`).
4. Paste the Privacy Policy URL (`https://github.com/amxson/recall/blob/main/PRIVACY.md`) after pushing `PRIVACY.md` to `main`.
