# Recall Chrome Extension (MV3)

Local-first hybrid search extension for saving and recalling passages from documentation pages and articles you have read.

## Architecture

```text
Popup (popup.html / popup.ts)
  │  chrome.runtime.sendMessage
  ▼
Service Worker (service_worker.ts)   ← stateless, survives MV3 idle suspension
  │  chrome.scripting.executeScript (activeTab -> content_extract.js)
  │  chrome.offscreen.createDocument
  ▼
Offscreen Document (offscreen.html / runtime.ts)
  ├─ recall-wasm (BM25 + brute-force L2 cosine + RRF k=60)
  ├─ @huggingface/transformers (Xenova/all-MiniLM-L6-v2, q8, local ort-wasm)
  └─ IndexedDB snapshot store (storage/idb.ts)
```

- **Why an offscreen document:** MV3 service workers terminate when idle and cannot hold a loaded ONNX/WASM runtime. Hosting `WasmRecallIndex` and the embedding model inside `offscreen.html` and persisting JSON snapshots to IndexedDB keeps the index durable across browser restarts.
- **Zero remote code execution:** `onnxruntime-web` WASM/MJS runtime files are bundled locally under `dist/ort/` during the build (`scripts/build-wasm.mjs`). Model weights (`~22.6 MB`) download once from Hugging Face and cache in Chrome's Cache API.

## Permissions

| Permission | Why it is requested |
| --- | --- |
| `activeTab` | Grants temporary access to the active tab **only** when you click **Save this page**. No `<all_urls>` permission and no passive history scraping. |
| `scripting` | Injects `content_extract.js` on click to extract readable headings/prose via Mozilla Readability, and applies a subtle DOM highlight fallback if `#:~:text=` cannot match across inline tags. |
| `offscreen` | Hosts the persistent `recall-wasm` and local MiniLM embedding runtime. |
| `storage` | Persists your chosen chunking strategy preference (`heading`, `fixed`, or `sentence`). |

## Keyboard Shortcuts

- `Alt+K` — Open Recall popup
- `↓` / `↑` — Move through ranked passage results
- `Enter` — Open the selected page scrolled and highlighted to the matched passage

## Build, Test, and Load Unpacked

```bash
cd extension
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test

# Optional: verify MV3 assets and produce recall-extension-v0.1.0.zip
npm run package
```

To install locally in Chrome:
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `extension/dist`.
3. Visit any documentation page or article, press `Alt+K`, and click **Save this page**.

## Known v0.1 Limitations

- Click-to-save only; does not automatically index pages in the background.
- Best suited for readable documentation pages and articles. PDFs, login-walled web apps, and canvas-rendered SPAs are out of scope for v0.1.
- First-time semantic indexing downloads `~22.6 MB` of quantized MiniLM weights (cached locally thereafter); **Keyword** mode works immediately with zero model load.
