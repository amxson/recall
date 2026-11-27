import { describe, expect, it, vi } from "vitest";
import type { SearchResponse } from "../shared/types";
import { EMPTY_SEARCH_RESPONSE, SearchController } from "./search-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SAMPLE_RESPONSE: SearchResponse = {
  results: [
    {
      chunk_id: 1,
      doc_id: "https://example.com/a",
      url: "https://example.com/a",
      jump_url: "https://example.com/a#:~:text=hello",
      title: "Example A",
      heading: "Intro",
      text: "Hello world",
      anchor_phrase: "Hello world",
      score: 0.9,
      bm25_rank: 1,
      bm25_score: 2.5,
      vector_rank: 1,
      vector_score: 0.85,
    },
  ],
  embed_ms: 12,
  search_ms: 0.4,
  total_ms: 12.4,
};

describe("SearchController", () => {
  it("invalidates an in-flight search when the input is cleared", async () => {
    const pending = deferred<SearchResponse>();
    const onResults = vi.fn();
    const onSearching = vi.fn();
    const onError = vi.fn();

    const controller = new SearchController({
      execute: () => pending.promise,
      onSearching,
      onResults,
      onError,
    });

    const first = controller.run("dependency injection", "hybrid");
    expect(onSearching).toHaveBeenCalledTimes(1);

    // Clearing the input (via clear() or run("", ...)) must invalidate the in-flight query.
    await controller.run("", "hybrid");
    expect(onResults).toHaveBeenLastCalledWith(EMPTY_SEARCH_RESPONSE, "");

    pending.resolve(SAMPLE_RESPONSE);
    await first;

    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops stale out-of-order results and errors from earlier queries", async () => {
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    const onResults = vi.fn();
    const onError = vi.fn();

    let call = 0;
    const controller = new SearchController({
      execute: () => (++call === 1 ? first.promise : second.promise),
      onSearching: () => {},
      onResults,
      onError,
    });

    const p1 = controller.run("first query", "hybrid");
    const p2 = controller.run("second query", "hybrid");

    second.resolve(SAMPLE_RESPONSE);
    await p2;
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenLastCalledWith(SAMPLE_RESPONSE, "second query");

    first.reject(new Error("stale error"));
    await p1;
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
