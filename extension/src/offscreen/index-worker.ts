import type { MessageResponse, RuntimeRequest } from "../shared/types";
import { setEmbedderProgressListener, type EmbedderProgress } from "./embedder";
import { OffscreenRuntime, type SavePhaseUpdate } from "./runtime";

export type WorkerReply =
  | { id: number; response: MessageResponse }
  | { progress: EmbedderProgress }
  | { savePhase: SavePhaseUpdate };

const runtime = new OffscreenRuntime({
  onSavePhase: (savePhase) => {
    self.postMessage({ savePhase } satisfies WorkerReply);
  },
});

setEmbedderProgressListener((progress) => {
  self.postMessage({ progress } satisfies WorkerReply);
});

self.addEventListener("message", (event: MessageEvent<{ id: number; request: RuntimeRequest }>) => {
  const { id, request } = event.data;
  void runtime.handleMessage(request).then((response) => {
    self.postMessage({ id, response } satisfies WorkerReply);
  });
});
