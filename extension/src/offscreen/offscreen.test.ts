import { afterEach, expect, it, vi } from "vitest";
import type { MessageResponse, OffscreenRequest, RuntimeRequest } from "../shared/types";
import type { WorkerReply } from "./index-worker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("acknowledges a save immediately, tracks save phases, and accepts another page and a search while it runs", async () => {
  const requests: Array<{ id: number; request: RuntimeRequest }> = [];
  let deliver!: (reply: WorkerReply) => void;
  class TestWorker {
    set onmessage(handler: (event: { data: WorkerReply }) => void) {
      deliver = (data) => handler({ data });
    }
    postMessage(message: (typeof requests)[number]): void {
      requests.push(message);
    }
  }

  type Listener = (
    request: OffscreenRequest,
    sender: unknown,
    reply: (response: MessageResponse) => void
  ) => void;
  let handle!: Listener;
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: (listener: Listener) => {
          handle = listener;
        },
      },
    },
  });
  await import("./offscreen");

  const send = (request: OffscreenRequest) =>
    new Promise<MessageResponse>((resolve) => {
      handle(request, null, resolve);
    });
  const save = (url: string) =>
    send({
      target: "offscreen",
      type: "INDEX_PAGE",
      payload: { url, title: "Article", markdown: "Some text" },
    });
  const status = (doc_id: string) => send({ target: "offscreen", type: "GET_SAVE_STATUS", doc_id });
  const article = "https://example.com/one";

  expect(await save(article)).toEqual({ ok: true, data: { state: "saving", phase: "keyword" } });
  expect(await save(article + "#section")).toEqual({
    ok: true,
    data: { state: "saving", phase: "keyword" },
  });
  expect(await save("https://example.com/two")).toEqual({
    ok: true,
    data: { state: "saving", phase: "keyword" },
  });
  expect(requests).toHaveLength(2);
  expect(await status(article)).toEqual({ ok: true, data: { state: "saving", phase: "keyword" } });

  // Phase 1 completion transitions status to embedding phase
  deliver({ savePhase: { doc_id: article, phase: "embedding", chunk_count: 4 } });
  expect(await status(article)).toEqual({
    ok: true,
    data: { state: "saving", phase: "embedding", chunk_count: 4 },
  });

  const search = send({
    target: "offscreen",
    type: "SEARCH",
    query: "article",
    mode: "keyword",
    top_k: 3,
  });
  deliver({ id: requests[2].id, response: { ok: true, data: { results: [] } } });
  await expect(search).resolves.toEqual({ ok: true, data: { results: [] } });

  deliver({ id: requests[0].id, response: { ok: false, error: "Storage write failed" } });
  await vi.waitFor(async () => {
    expect(await status(article)).toEqual({
      ok: true,
      data: { state: "error", error: "Storage write failed" },
    });
  });

  // Clearing the index wipes stale save status entries
  const clearReq = send({ target: "offscreen", type: "CLEAR_INDEX" });
  deliver({ id: requests[3].id, response: { ok: true, data: { cleared: true } } });
  await expect(clearReq).resolves.toEqual({ ok: true, data: { cleared: true } });
  expect(await status(article)).toEqual({ ok: true, data: undefined });

  expect(await save(article)).toEqual({ ok: true, data: { state: "saving", phase: "keyword" } });
  expect(requests).toHaveLength(5);
});
