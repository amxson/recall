import type {
  ActiveTabStatus,
  DocumentSummary,
  MessageResponse,
  OffscreenRequest,
  PageExtractPayload,
  PopupRequest,
} from "../shared/types";
import { normalizeUrlToDocId } from "../shared/url";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (typeof chrome.runtime.getContexts === "function") {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl],
    });
    if (existing.length > 0) {
      return;
    }
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        "Runs Rust/WASM hybrid search index and local MiniLM embeddings persistently outside ephemeral service worker lifecycle.",
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  await creatingOffscreen;
}

async function sendToOffscreen<T = unknown>(
  message: OffscreenRequest
): Promise<MessageResponse<T>> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
}

async function extractActiveTab(): Promise<PageExtractPayload> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("no active tab available");
  }
  if (!tab.url.startsWith("http://") && !tab.url.startsWith("https://")) {
    throw new Error("only http/https documentation and article pages can be saved");
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content_extract.js"],
  });

  const payload = results[0]?.result as PageExtractPayload | undefined;
  if (!payload || !payload.markdown.trim()) {
    throw new Error("could not extract readable text from this page");
  }
  return payload;
}

async function openResultTab(
  jumpUrl: string,
  fallbackUrl: string,
  anchorPhrase: string
): Promise<{ tabId: number | undefined }> {
  const targetUrl = jumpUrl || fallbackUrl;
  const created = await chrome.tabs.create({ url: targetUrl });

  if (created.id && anchorPhrase.trim()) {
    const tabId = created.id;
    const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId !== tabId || info.status !== "complete") {
        return;
      }
      chrome.tabs.onUpdated.removeListener(listener);
      // Fallback highlight for pages where native Chrome #:~:text= cannot match across inline tags
      void chrome.scripting
        .executeScript({
          target: { tabId },
          func: highlightFallbackInPage,
          args: [anchorPhrase],
        })
        .catch(() => {
          // Non-fatal if host permission is restricted; native #:~:text= already handled navigation
        });
    };
    chrome.tabs.onUpdated.addListener(listener);
  }

  return { tabId: created.id };
}

function highlightFallbackInPage(phrase: string): void {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalize(phrase);
  if (!needle || needle.length < 8) return;

  // Prefer matching a single text node first for surgical inline highlighting
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const idx = text.toLowerCase().indexOf(needle);
    if (idx === -1) continue;

    const parent = node.parentElement;
    if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;

    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, Math.min(text.length, idx + phrase.length));
    const mark = document.createElement("mark");
    mark.setAttribute("data-recall-highlight", "true");
    mark.style.backgroundColor = "rgba(51, 224, 146, 0.35)";
    mark.style.color = "inherit";
    mark.style.borderRadius = "3px";
    mark.style.padding = "0 2px";
    try {
      range.surroundContents(mark);
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    } catch {
      parent.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }

  // Fallback for phrases split across inline tags like <code> or <strong>
  const blocks = document.querySelectorAll<HTMLElement>(
    "p, li, dd, blockquote, h1, h2, h3, h4, td"
  );
  for (const el of blocks) {
    const blockText = normalize(el.textContent ?? "");
    if (!blockText.includes(needle)) continue;

    const prevBg = el.style.backgroundColor;
    const prevOutline = el.style.outline;
    const prevTransition = el.style.transition;

    el.style.transition = "background-color 0.4s ease, outline-color 0.4s ease";
    el.style.backgroundColor = "rgba(51, 224, 146, 0.18)";
    el.style.outline = "2px solid rgba(51, 224, 146, 0.55)";
    el.style.borderRadius = "4px";
    el.scrollIntoView({ behavior: "smooth", block: "center" });

    window.setTimeout(() => {
      el.style.backgroundColor = prevBg;
      el.style.outline = prevOutline;
      el.style.transition = prevTransition;
    }, 4500);
    return;
  }
}

async function getActiveTabStatus(): Promise<ActiveTabStatus> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? null;
  const saveable = Boolean(url && (url.startsWith("http://") || url.startsWith("https://")));
  if (!url || !saveable) {
    return { url, saveable: false, already_saved: false };
  }

  const normalized = normalizeUrlToDocId(url);
  const resp = await sendToOffscreen<DocumentSummary[]>({
    target: "offscreen",
    type: "LIST_DOCS",
  });
  const alreadySaved =
    resp.ok && resp.data.some((doc) => doc.doc_id === normalized || doc.url === normalized);
  return { url, saveable: true, already_saved: alreadySaved };
}

async function handlePopupRequest(msg: PopupRequest): Promise<MessageResponse> {
  try {
    switch (msg.type) {
      case "GET_STATS":
        return await sendToOffscreen({ target: "offscreen", type: "GET_STATS" });
      case "GET_ACTIVE_TAB_STATUS": {
        const data = await getActiveTabStatus();
        return { ok: true, data };
      }
      case "LIST_DOCS":
        return await sendToOffscreen({ target: "offscreen", type: "LIST_DOCS" });
      case "REMOVE_DOC":
        return await sendToOffscreen({
          target: "offscreen",
          type: "REMOVE_DOC",
          doc_id: msg.doc_id,
        });
      case "SEARCH":
        return await sendToOffscreen({
          target: "offscreen",
          type: "SEARCH",
          query: msg.query,
          mode: msg.mode,
          top_k: msg.top_k,
        });
      case "SAVE_ACTIVE_TAB": {
        const extracted = await extractActiveTab();
        return await sendToOffscreen({
          target: "offscreen",
          type: "INDEX_PAGE",
          payload: { ...extracted, strategy: msg.strategy },
        });
      }
      case "OPEN_RESULT": {
        const data = await openResultTab(msg.jump_url, msg.url, msg.anchor_phrase);
        return { ok: true, data };
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { target?: string }).target !== "background"
  ) {
    return false;
  }

  void handlePopupRequest(message as PopupRequest).then((resp) => sendResponse(resp));
  return true;
});
