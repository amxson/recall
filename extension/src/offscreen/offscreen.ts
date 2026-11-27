import type {
  IndexPageMetrics,
  MessageResponse,
  ModelProgressBroadcast,
  OffscreenRequest,
  RuntimeRequest,
  SaveStatus,
} from "../shared/types";
import { normalizeUrlToDocId } from "../shared/url";
import type { WorkerReply } from "./index-worker";

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (response: MessageResponse) => void>();
const saves = new Map<string, SaveStatus>();

function getWorker(): Worker {
  if (worker) return worker;

  const instance = new Worker(new URL("./index-worker.ts", import.meta.url), { type: "module" });
  let lastProgress = "";
  instance.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    if ("id" in data) {
      pending.get(data.id)?.(data.response);
      pending.delete(data.id);
      return;
    }

    if ("savePhase" in data) {
      const current = saves.get(data.savePhase.doc_id);
      if (current?.state === "saving") {
        saves.set(data.savePhase.doc_id, {
          state: "saving",
          phase: data.savePhase.phase,
          chunk_count: data.savePhase.chunk_count,
        });
      }
      return;
    }

    const event = data.progress;
    const rounded = typeof event.progress === "number" ? Math.round(event.progress) : undefined;
    const key = JSON.stringify([event.status, event.file, rounded]);
    if (key === lastProgress) return;
    lastProgress = key;

    const message: ModelProgressBroadcast = {
      target: "popup",
      type: "MODEL_PROGRESS",
      status: event.status,
      file: event.file,
      progress: rounded,
    };
    void chrome.runtime.sendMessage(message).catch(() => {
      // The popup can be closed while the model downloads.
    });
  };
  instance.onerror = (event) => {
    instance.terminate();
    worker = undefined;
    for (const finish of pending.values()) {
      finish({ ok: false, error: event.message || "Recall's index worker stopped. Try again." });
    }
    pending.clear();
  };
  worker = instance;
  return instance;
}

async function requestWorker(request: RuntimeRequest): Promise<MessageResponse> {
  const instance = getWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    try {
      instance.postMessage({ id, request });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

function finishSave(docId: string, status: SaveStatus): void {
  saves.delete(docId);
  saves.set(docId, status);
  if (saves.size > 32) {
    const oldestFinished = [...saves].find(([, entry]) => entry.state !== "saving");
    if (oldestFinished) saves.delete(oldestFinished[0]);
  }
}

async function handleRequest(request: OffscreenRequest): Promise<MessageResponse> {
  if (request.type === "GET_SAVE_STATUS") {
    return { ok: true, data: saves.get(request.doc_id) };
  }
  if (request.type !== "INDEX_PAGE") {
    const response = await requestWorker(request);
    if (response.ok) {
      if (request.type === "CLEAR_INDEX") {
        saves.clear();
      } else if (request.type === "REMOVE_DOC") {
        saves.delete(request.doc_id);
      }
    }
    return response;
  }

  const docId = normalizeUrlToDocId(request.payload.url);
  const saving: SaveStatus = { state: "saving", phase: "keyword" };
  if (saves.get(docId)?.state !== "saving") {
    saves.set(docId, saving);
    void requestWorker(request)
      .then((response) => {
        finishSave(
          docId,
          response.ok
            ? { state: "saved", metrics: response.data as IndexPageMetrics }
            : { state: "error", error: response.error }
        );
      })
      .catch((error) => {
        finishSave(docId, {
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  return { ok: true, data: saves.get(docId) ?? saving };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { target?: string }).target !== "offscreen"
  ) {
    return false;
  }

  void handleRequest(message as OffscreenRequest)
    .then((response) => sendResponse(response))
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return true;
});
