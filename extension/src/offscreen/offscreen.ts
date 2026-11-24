import type { ModelProgressBroadcast, OffscreenRequest } from "../shared/types";
import { setEmbedderProgressListener } from "./embedder";
import { OffscreenRuntime } from "./runtime";

const runtime = new OffscreenRuntime();

let lastProgressPct = -1;
setEmbedderProgressListener((event) => {
  const rounded = typeof event.progress === "number" ? Math.round(event.progress) : undefined;
  if (rounded !== undefined && rounded === lastProgressPct) {
    return;
  }
  if (rounded !== undefined) {
    lastProgressPct = rounded;
  }
  const msg: ModelProgressBroadcast = {
    target: "popup",
    type: "MODEL_PROGRESS",
    status: event.status,
    file: event.file,
    progress: rounded,
  };
  void chrome.runtime.sendMessage(msg).catch(() => {
    // Popup may not be open while offscreen finishes initializing
  });
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { target?: string }).target !== "offscreen"
  ) {
    return false;
  }

  void runtime
    .handleMessage(message as OffscreenRequest)
    .then((response) => sendResponse(response))
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return true;
});
