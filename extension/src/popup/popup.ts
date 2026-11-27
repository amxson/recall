import type {
  ActiveTabStatus,
  ChunkingMode,
  DocumentSummary,
  IndexStats,
  MessageResponse,
  ModelProgressBroadcast,
  PopupRequest,
  SearchMode,
  SearchResponse,
  SearchResult,
} from "../shared/types";
import { SearchController } from "./search-controller";

const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const statsPill = document.getElementById("stats-pill") as HTMLSpanElement;
const statusBar = document.getElementById("status-bar") as HTMLDivElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const latencyReadout = document.getElementById("latency-readout") as HTMLSpanElement;
const resultsList = document.getElementById("results-list") as HTMLDivElement;
const docsList = document.getElementById("docs-list") as HTMLDivElement;
const tabSearch = document.getElementById("tab-search") as HTMLButtonElement;
const tabSaved = document.getElementById("tab-saved") as HTMLButtonElement;
const panelSearch = document.getElementById("panel-search") as HTMLElement;
const panelSaved = document.getElementById("panel-saved") as HTMLElement;
const chunkerSelect = document.getElementById("chunker-select") as HTMLSelectElement;
const storageBar = document.getElementById("storage-bar") as HTMLDivElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode-btn"));

let activeMode: SearchMode = "hybrid";
let activeChunker: ChunkingMode = "heading";
let searchTimer: number | null = null;
let currentHits: SearchResult[] = [];
let selectedIdx = 0;
let saveButtonIdleLabel = "Save this page";
let savePoll: number | undefined;
let watchingSave = false;
let lastRefreshedPhase: string | null = null;
let clearArmed = false;

const searchController = new SearchController({
  execute: (query, mode) =>
    sendBg<SearchResponse>({
      target: "background",
      type: "SEARCH",
      query,
      mode,
      top_k: 8,
    }),
  onSearching: () => {
    latencyReadout.textContent = "searching…";
  },
  onResults: (resp, query) => {
    renderResults(resp, query);
  },
  onError: (message) => {
    latencyReadout.textContent = "";
    showStatus(message, true);
  },
});

async function sendBg<T>(msg: PopupRequest): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(msg)) as MessageResponse<T>;
  if (!resp || !resp.ok) {
    throw new Error(resp?.error ?? "background communication failed");
  }
  return resp.data;
}

function showStatus(text: string, isError: boolean = false): void {
  statusBar.textContent = text;
  statusBar.classList.toggle("error", isError);
  statusBar.classList.remove("hidden");
}

function hideStatus(): void {
  statusBar.classList.add("hidden");
}

async function refreshStats(): Promise<void> {
  try {
    const [stats, tabStatus] = await Promise.all([
      sendBg<IndexStats>({ target: "background", type: "GET_STATS" }),
      sendBg<ActiveTabStatus>({ target: "background", type: "GET_ACTIVE_TAB_STATUS" }),
    ]);
    statsPill.textContent = `${stats.document_count} pages · ${stats.chunk_count} passages`;
    const kb = ((stats.snapshot_bytes ?? 0) / 1024).toFixed(1);
    storageBar.textContent = `IndexedDB: ${kb} KB · ${stats.vector_count} vectors (${stats.embedding_dim}d) · ${stats.vocab_size} terms`;
    renderSaveStatus(tabStatus);
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function watchSave(phase?: "keyword" | "embedding", chunkCount?: number): void {
  watchingSave = true;
  saveBtn.disabled = true;
  if (phase === "embedding" && chunkCount) {
    saveBtn.textContent = "Adding semantic index…";
    showStatus(`Saved ${chunkCount} passages for keyword search · adding semantic embeddings…`);
    if (lastRefreshedPhase !== "embedding") {
      lastRefreshedPhase = "embedding";
      void refreshSavedDocs();
    }
  } else {
    saveBtn.textContent = "Saving in background…";
  }
  window.clearTimeout(savePoll);
  savePoll = window.setTimeout(() => {
    void refreshStats();
  }, 1000);
}

function renderSaveStatus(tabStatus: ActiveTabStatus): void {
  if (tabStatus.save_status?.state === "saving") {
    watchSave(tabStatus.save_status.phase, tabStatus.save_status.chunk_count);
    return;
  }

  window.clearTimeout(savePoll);
  lastRefreshedPhase = null;
  const result = tabStatus.save_status;
  const embeddingsFailed =
    result?.state === "saved" && result.metrics.embeddings_status === "failed";

  saveButtonIdleLabel = !tabStatus.saveable
    ? "Page not saveable"
    : embeddingsFailed
      ? "Retry semantic index"
      : tabStatus.already_saved
        ? "Re-index page"
        : "Save this page";
  saveBtn.textContent = saveButtonIdleLabel;
  saveBtn.disabled = !tabStatus.saveable;

  if (result?.state === "error") {
    showStatus(result.error, true);
  } else if (embeddingsFailed && result.state === "saved") {
    const reason = result.metrics.embedding_error || "local AI model unavailable";
    showStatus(
      `Saved ${result.metrics.chunk_count} passages for keyword search. Semantic model unavailable (${reason}) — click Retry semantic index when online.`,
      true
    );
    if (watchingSave) {
      void refreshSavedDocs();
      if (searchInput.value.trim()) void runSearch();
    }
  } else if (watchingSave && result?.state === "saved") {
    showStatus(`Saved ${result.metrics.chunk_count} passages (hybrid search ready).`);
    void refreshSavedDocs();
    if (searchInput.value.trim()) void runSearch();
  }
  watchingSave = false;
}

async function refreshSavedDocs(): Promise<void> {
  try {
    const docs = await sendBg<DocumentSummary[]>({ target: "background", type: "LIST_DOCS" });
    renderDocs(docs);
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function renderDocs(docs: DocumentSummary[]): void {
  docsList.innerHTML = "";
  if (docs.length === 0) {
    docsList.innerHTML = '<p class="empty">No pages saved yet.</p>';
    return;
  }

  for (const doc of docs) {
    const row = document.createElement("div");
    row.className = "doc-row";

    const info = document.createElement("div");
    info.className = "doc-info";

    const title = document.createElement("div");
    title.className = "doc-title";
    title.textContent = doc.title;

    const meta = document.createElement("div");
    meta.className = "doc-meta";
    const dateStr = doc.saved_at_ms ? new Date(doc.saved_at_ms).toLocaleDateString() : "";
    meta.textContent = `${doc.chunk_count} passages · ${shortHost(doc.url)}${dateStr ? ` · ${dateStr}` : ""}`;

    info.append(title, meta);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      try {
        await sendBg({ target: "background", type: "REMOVE_DOC", doc_id: doc.doc_id });
        await Promise.all([refreshStats(), refreshSavedDocs()]);
      } catch (err) {
        showStatus(err instanceof Error ? err.message : String(err), true);
      }
    });

    row.append(info, removeBtn);
    docsList.append(row);
  }
}

function renderResults(resp: SearchResponse, query: string): void {
  resultsList.innerHTML = "";
  currentHits = resp.results;
  selectedIdx = 0;

  if (!query.trim()) {
    latencyReadout.textContent = "";
    resultsList.innerHTML =
      '<p class="empty">Save documentation pages or articles, then search them here by exact term or rough idea.</p>';
    return;
  }

  if (resp.degraded_to_keyword) {
    latencyReadout.textContent = `keyword fallback · search ${resp.search_ms.toFixed(2)} ms`;
    if (resp.warning) {
      showStatus(resp.warning, false);
    }
  } else {
    latencyReadout.textContent =
      activeMode === "keyword"
        ? `search ${resp.search_ms.toFixed(2)} ms`
        : `embed ${resp.embed_ms.toFixed(0)} ms · search ${resp.search_ms.toFixed(2)} ms`;
  }

  if (resp.results.length === 0) {
    resultsList.innerHTML = '<p class="empty">No matching passages found.</p>';
    return;
  }

  resp.results.forEach((hit, idx) => {
    const card = buildHitCard(hit);
    if (idx === selectedIdx) {
      card.classList.add("selected");
    }
    card.addEventListener("mouseenter", () => setSelectedIndex(idx));
    resultsList.append(card);
  });
}

function setSelectedIndex(next: number): void {
  if (currentHits.length === 0) return;
  selectedIdx = (next + currentHits.length) % currentHits.length;
  const cards = resultsList.querySelectorAll<HTMLButtonElement>(".hit-card");
  cards.forEach((el, idx) => {
    const active = idx === selectedIdx;
    el.classList.toggle("selected", active);
    if (active) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

async function openHit(hit: SearchResult): Promise<void> {
  try {
    await sendBg({
      target: "background",
      type: "OPEN_RESULT",
      url: hit.url,
      jump_url: hit.jump_url,
      anchor_phrase: hit.anchor_phrase,
    });
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function buildHitCard(hit: SearchResult): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "hit-card";

  const top = document.createElement("div");
  top.className = "hit-top";

  const title = document.createElement("span");
  title.className = "hit-title";
  title.textContent = hit.title;

  const badges = document.createElement("span");
  badges.className = "hit-badges";
  if (hit.bm25_rank !== null) {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = `BM25 #${hit.bm25_rank}`;
    badges.append(b);
  }
  if (hit.vector_rank !== null) {
    const v = document.createElement("span");
    v.className = "badge em";
    v.textContent = `Vec #${hit.vector_rank}`;
    badges.append(v);
  }

  top.append(title, badges);
  card.append(top);

  if (hit.heading) {
    const heading = document.createElement("div");
    heading.className = "hit-heading";
    heading.textContent = hit.heading;
    card.append(heading);
  }

  const snippet = document.createElement("div");
  snippet.className = "hit-snippet";
  snippet.textContent = hit.text;

  const urlEl = document.createElement("div");
  urlEl.className = "hit-url";
  urlEl.textContent = hit.url;

  card.append(snippet, urlEl);

  card.addEventListener("click", () => {
    void openHit(hit);
  });

  return card;
}

async function runSearch(): Promise<void> {
  await searchController.run(searchInput.value, activeMode);
}

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  saveBtn.textContent = "Reading page…";
  hideStatus();

  try {
    await sendBg({
      target: "background",
      type: "SAVE_ACTIVE_TAB",
      strategy: activeChunker,
    });
    watchSave();
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), true);
    saveBtn.disabled = false;
    saveBtn.textContent = saveButtonIdleLabel;
  }
});

searchInput.addEventListener("keydown", (event) => {
  if (currentHits.length === 0) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setSelectedIndex(selectedIdx + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setSelectedIndex(selectedIdx - 1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const hit = currentHits[selectedIdx];
    if (hit) {
      void openHit(hit);
    }
  }
});

searchInput.addEventListener("input", () => {
  hideStatus();
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
  }
  if (!searchInput.value.trim()) {
    searchController.clear();
    return;
  }
  searchTimer = window.setTimeout(() => {
    void runSearch();
  }, 140);
});

for (const btn of modeButtons) {
  btn.addEventListener("click", () => {
    activeMode = (btn.dataset.mode as SearchMode) || "hybrid";
    for (const other of modeButtons) {
      other.classList.toggle("active", other === btn);
    }
    if (searchInput.value.trim()) {
      void runSearch();
    }
  });
}

tabSearch.addEventListener("click", () => {
  tabSearch.classList.add("active");
  tabSaved.classList.remove("active");
  panelSearch.classList.remove("hidden");
  panelSaved.classList.add("hidden");
  searchInput.focus();
});

tabSaved.addEventListener("click", () => {
  tabSaved.classList.add("active");
  tabSearch.classList.remove("active");
  panelSaved.classList.remove("hidden");
  panelSearch.classList.add("hidden");
  void refreshSavedDocs();
});

function shortHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

chunkerSelect.addEventListener("change", () => {
  activeChunker = (chunkerSelect.value as ChunkingMode) || "heading";
  void chrome.storage?.local?.set({ recall_chunker: activeChunker });
});

clearBtn.addEventListener("click", async () => {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = "Click again to clear";
    window.setTimeout(() => {
      clearArmed = false;
      clearBtn.textContent = "Clear index";
    }, 3500);
    return;
  }

  clearArmed = false;
  clearBtn.disabled = true;
  clearBtn.textContent = "Clearing…";
  try {
    await sendBg({ target: "background", type: "CLEAR_INDEX" });
    searchController.clear();
    showStatus("Local index cleared.");
    await Promise.all([refreshStats(), refreshSavedDocs()]);
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    clearBtn.disabled = false;
    clearBtn.textContent = "Clear index";
  }
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object") return;
  const msg = message as Partial<ModelProgressBroadcast>;
  if (msg.target !== "popup" || msg.type !== "MODEL_PROGRESS") return;
  if (typeof msg.progress === "number") {
    const label = msg.file ? ` (${msg.file})` : "";
    showStatus(`Downloading local model${label}… ${msg.progress}%`);
  }
});

async function bootstrap(): Promise<void> {
  try {
    const stored = await chrome.storage?.local?.get("recall_chunker");
    const saved = stored?.recall_chunker as ChunkingMode | undefined;
    if (saved && ["heading", "fixed", "sentence"].includes(saved)) {
      activeChunker = saved;
      chunkerSelect.value = saved;
    }
  } catch {
    // Ignore storage read errors outside extension context
  }
  await refreshStats();
}

void bootstrap();
