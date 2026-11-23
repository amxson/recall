import type { OffscreenRequest } from "../shared/types";
import { OffscreenRuntime } from "./runtime";

const runtime = new OffscreenRuntime();

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
