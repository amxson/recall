# Recall Privacy Policy

Last updated: November 27, 2026

Recall is a local-first Chrome extension for searching documentation pages and articles you explicitly choose to save. Your saved content and search queries never leave your browser.

## What Data Recall Processes

When you click **Save this page** in the Recall popup, the extension reads only the active tab's:
- Page URL
- Page title
- Readable article text and section headings (extracted locally using Mozilla Readability)

Recall does **not** run in the background on pages you browse, does **not** read your browsing history or bookmarks, does **not** require an account, and does **not** collect analytics, telemetry, crash reports, or tracking identifiers.

## How and Where Data Is Stored

All user data stays strictly on your device inside Chrome's extension storage:
- **IndexedDB (`recall_local_index`)**: stores your saved page metadata, text passages, BM25 keyword index, and dense semantic vectors.
- **`chrome.storage.local`**: stores your selected chunking preference (`heading`, `fixed`, or `sentence`).
- **Browser Cache Storage (`transformers-cache`)**: caches the downloaded open-source embedding model weights locally so subsequent indexing and searches work offline.

Recall does not operate any backend server and never transmits your saved pages, URLs, or search queries to the developer or any third party.

## External Network Requests

To enable on-device semantic and hybrid search, Recall performs a one-time download of the open-source `Xenova/all-MiniLM-L6-v2` quantized (`q8`, ~22.6 MB) ONNX embedding model and tokenizer files from Hugging Face (`https://huggingface.co`).

- Only standard HTTP `GET` requests for those static model files are made.
- No page text, URLs, search queries, or personal data are included in those requests.
- Once cached in Chrome's Cache Storage, Recall runs completely offline.
- If you are offline when saving a page before the model has been downloaded, Recall still saves your page locally for keyword search without requiring network access.

## Permissions Used

- **`activeTab`**: grants temporary access to the current tab only when you explicitly click **Save this page**.
- **`scripting`**: injects the bundled Readability extractor on click and highlights the matched passage when jumping back to a saved page.
- **`offscreen`**: hosts the local Rust/WebAssembly search engine and Web Worker embedding runtime while the popup is closed.
- **`storage`**: saves your chunking preference locally.

## Deleting Your Data

You control all locally stored data at any time:
- Remove any individual saved page from the **Saved** tab in the Recall popup.
- Click **Clear index** in the Recall popup to delete the entire IndexedDB index immediately.
- Uninstall the Recall extension from `chrome://extensions` to remove all IndexedDB, `chrome.storage.local`, and cached model data associated with the extension.

## Contact

Questions or privacy inquiries: open an issue at https://github.com/amxson/recall/issues or email `amarasfaw1077@gmail.com`.
