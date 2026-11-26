import type { MessageResponse, RuntimeRequest } from "../shared/types";
import { setEmbedderProgressListener, type EmbedderProgress } from "./embedder";
import { OffscreenRuntime } from "./runtime";

export type WorkerReply =
  | { id: number; response: MessageResponse }
  | { progress: EmbedderProgress };

const runtime = new OffscreenRuntime();

setEmbedderProgressListener((progress) => {
  self.postMessage({ progress } satisfies WorkerReply);
});

self.addEventListener("message", (event: MessageEvent<{ id: number; request: RuntimeRequest }>) => {
  const { id, request } = event.data;
  void runtime.handleMessage(request).then((response) => {
    self.postMessage({ id, response } satisfies WorkerReply);
  });
});
