import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { DocumentSummary, IndexPageMetrics, IndexStats, SearchResponse } from "../shared/types";
import type { StoredSnapshot } from "../storage/idb";
import { initSync } from "../wasm/recall_wasm";
import { normalizeUrlToDocId, OffscreenRuntime } from "./runtime";

beforeAll(() => {
  const wasmPath = resolve(__dirname, "..", "wasm", "recall_wasm_bg.wasm");
  initSync({ module: readFileSync(wasmPath) });
});

function stubVector(text: string): Float32Array {
  const lower = text.toLowerCase();
  const v0 = lower.includes("background") || lower.includes("email") ? 0.95 : 0.1;
  const v1 = lower.includes("cors") || lower.includes("origin") ? 0.95 : 0.1;
  const v2 = lower.includes("error") || lower.includes("exception") ? 0.95 : 0.1;
  const norm = Math.hypot(v0, v1, v2);
  return new Float32Array([v0 / norm, v1 / norm, v2 / norm]);
}

function createMemoryRuntime() {
  let saved: StoredSnapshot | null = null;
  let embedCalls = 0;

  const runtime = new OffscreenRuntime({
    dim: 3,
    ensureWasm: async () => "0.1.0",
    loadSnapshot: async () => saved,
    saveSnapshot: async (json, stats) => {
      const meta = {
        updatedAtMs: Date.now(),
        byteLength: Buffer.byteLength(json, "utf8"),
        documentCount: stats.documentCount,
        chunkCount: stats.chunkCount,
      };
      saved = { key: "primary", json, meta };
      return meta;
    },
    embedText: async (text) => {
      embedCalls += 1;
      return stubVector(text);
    },
    embedBatch: async (texts) => {
      const flat = new Float32Array(texts.length * 3);
      texts.forEach((t, idx) => flat.set(stubVector(t), idx * 3));
      return { flat, dim: 3, elapsedMs: 4.2 };
    },
  });

  return {
    runtime,
    getSaved: () => saved,
    getEmbedCalls: () => embedCalls,
  };
}

describe("OffscreenRuntime", () => {
  it("normalizes urls consistently across hash fragments and trailing slashes", () => {
    expect(
      normalizeUrlToDocId("https://fastapi.tiangolo.com/tutorial/cors/#:~:text=Wildcards")
    ).toBe("https://fastapi.tiangolo.com/tutorial/cors");
    expect(normalizeUrlToDocId("https://fastapi.tiangolo.com/tutorial/cors")).toBe(
      "https://fastapi.tiangolo.com/tutorial/cors"
    );
  });

  it("indexes pages, persists snapshots, and supports keyword + hybrid search", async () => {
    const { runtime, getSaved, getEmbedCalls } = createMemoryRuntime();

    const indexResp = await runtime.handleMessage({
      target: "offscreen",
      type: "INDEX_PAGE",
      payload: {
        url: "https://fastapi.tiangolo.com/tutorial/background-tasks/#caveat",
        title: "Background Tasks",
        markdown:
          "# Background Tasks\n\nRun email notifications after returning a response.\n\n## Dependency Injection\n\nWorks across dependencies.",
      },
    });
    expect(indexResp.ok).toBe(true);
    const metrics = (indexResp as { ok: true; data: IndexPageMetrics }).data;
    expect(metrics.chunk_count).toBe(2);
    expect(metrics.snapshot_bytes).toBeGreaterThan(0);
    expect(getSaved()?.meta.documentCount).toBe(1);

    // Keyword search should bypass embedding model completely
    const kwResp = await runtime.handleMessage({
      target: "offscreen",
      type: "SEARCH",
      query: "email notifications",
      mode: "keyword",
      top_k: 3,
    });
    expect(kwResp.ok).toBe(true);
    expect((kwResp as { ok: true; data: SearchResponse }).data.embed_ms).toBe(0);
    expect(getEmbedCalls()).toBe(0);

    // Hybrid search invokes embedder and returns jump_url
    const hybridResp = await runtime.handleMessage({
      target: "offscreen",
      type: "SEARCH",
      query: "send email after response",
      mode: "hybrid",
      top_k: 3,
    });
    expect(hybridResp.ok).toBe(true);
    const hybridData = (hybridResp as { ok: true; data: SearchResponse }).data;
    expect(hybridData.results[0].title).toBe("Background Tasks");
    expect(hybridData.results[0].jump_url).toContain("#:~:text=");
    expect(getEmbedCalls()).toBe(1);

    // Re-indexing the same page without hash replaces instead of duplicating
    await runtime.handleMessage({
      target: "offscreen",
      type: "INDEX_PAGE",
      payload: {
        url: "https://fastapi.tiangolo.com/tutorial/background-tasks/",
        title: "Background Tasks Updated",
        markdown: "# Background Tasks\n\nUpdated background task note.",
      },
    });
    const statsResp = await runtime.handleMessage({ target: "offscreen", type: "GET_STATS" });
    const stats = (statsResp as { ok: true; data: IndexStats }).data;
    expect(stats.document_count).toBe(1);
    expect(stats.chunk_count).toBe(1);

    const listResp = await runtime.handleMessage({ target: "offscreen", type: "LIST_DOCS" });
    const docs = (listResp as { ok: true; data: DocumentSummary[] }).data;
    expect(docs[0].title).toBe("Background Tasks Updated");

    // Remove document updates persisted snapshot
    await runtime.handleMessage({
      target: "offscreen",
      type: "REMOVE_DOC",
      doc_id: metrics.doc_id,
    });
    expect(getSaved()?.meta.documentCount).toBe(0);

    runtime.dispose();
  });

  it("rehydrates persisted state in a fresh runtime instance", async () => {
    const first = createMemoryRuntime();
    await first.runtime.handleMessage({
      target: "offscreen",
      type: "INDEX_PAGE",
      payload: {
        url: "https://fastapi.tiangolo.com/tutorial/cors/",
        title: "CORS",
        markdown: "# CORS\n\nConfigure Cross-Origin Resource Sharing origins.",
      },
    });
    const persisted = first.getSaved();
    first.runtime.dispose();

    const second = new OffscreenRuntime({
      dim: 3,
      ensureWasm: async () => "0.1.0",
      loadSnapshot: async () => persisted,
      saveSnapshot: async (json, stats) => ({
        updatedAtMs: Date.now(),
        byteLength: json.length,
        documentCount: stats.documentCount,
        chunkCount: stats.chunkCount,
      }),
      embedText: async (t) => stubVector(t),
      embedBatch: async () => ({ flat: new Float32Array(0), dim: 3, elapsedMs: 0 }),
    });

    const resp = await second.handleMessage({
      target: "offscreen",
      type: "SEARCH",
      query: "origin sharing",
      mode: "hybrid",
      top_k: 2,
    });
    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: SearchResponse }).data.results[0].title).toBe("CORS");
    second.dispose();
  });
});
