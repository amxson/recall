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
    clearSnapshot: async () => {
      saved = null;
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
      clearSnapshot: async () => {},
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

    const statsBefore = (
      (await second.handleMessage({ target: "offscreen", type: "GET_STATS" })) as {
        ok: true;
        data: IndexStats;
      }
    ).data;
    expect(statsBefore.snapshot_bytes).toBeGreaterThan(0);

    const clearResp = await second.handleMessage({ target: "offscreen", type: "CLEAR_INDEX" });
    expect(clearResp.ok).toBe(true);

    const statsAfter = (
      (await second.handleMessage({ target: "offscreen", type: "GET_STATS" })) as {
        ok: true;
        data: IndexStats;
      }
    ).data;
    expect(statsAfter.document_count).toBe(0);
    expect(statsAfter.chunk_count).toBe(0);
    expect(statsAfter.snapshot_bytes).toBe(0);
    second.dispose();
  });

  it("keeps memory consistent with storage when save, remove, or clear persistence fails", async () => {
    let saved: StoredSnapshot | null = null;
    let failSave = false;
    let failClear = false;

    const runtime = new OffscreenRuntime({
      dim: 3,
      ensureWasm: async () => "0.1.0",
      loadSnapshot: async () => saved,
      saveSnapshot: async (json, stats) => {
        if (failSave) {
          throw new Error("QuotaExceededError: IndexedDB write failed");
        }
        const meta = {
          updatedAtMs: Date.now(),
          byteLength: Buffer.byteLength(json, "utf8"),
          documentCount: stats.documentCount,
          chunkCount: stats.chunkCount,
        };
        saved = { key: "primary", json, meta };
        return meta;
      },
      clearSnapshot: async () => {
        if (failClear) {
          throw new Error("IndexedDB delete failed");
        }
        saved = null;
      },
      embedText: async (t) => stubVector(t),
      embedBatch: async (texts) => {
        const flat = new Float32Array(texts.length * 3);
        texts.forEach((t, idx) => flat.set(stubVector(t), idx * 3));
        return { flat, dim: 3, elapsedMs: 2.0 };
      },
    });

    // Save one baseline page successfully
    const okSave = await runtime.handleMessage({
      target: "offscreen",
      type: "INDEX_PAGE",
      payload: {
        url: "https://fastapi.tiangolo.com/tutorial/cors/",
        title: "CORS",
        markdown: "# CORS\n\nConfigure Cross-Origin Resource Sharing origins.",
      },
    });
    expect(okSave.ok).toBe(true);

    // 1) Failed saveSnapshot during indexPage must NOT leave ghost results in memory
    failSave = true;
    const failedSave = await runtime.handleMessage({
      target: "offscreen",
      type: "INDEX_PAGE",
      payload: {
        url: "https://example.com/ghost",
        title: "Ghost Page",
        markdown: "# Ghost\n\nUnpersisted phantom content.",
      },
    });
    expect(failedSave.ok).toBe(false);
    const ghostSearch = (await runtime.handleMessage({
      target: "offscreen",
      type: "SEARCH",
      query: "phantom",
      mode: "keyword",
      top_k: 5,
    })) as { ok: true; data: SearchResponse };
    expect(ghostSearch.data.results).toHaveLength(0);
    const docsAfterFailedSave = (await runtime.handleMessage({
      target: "offscreen",
      type: "LIST_DOCS",
    })) as { ok: true; data: DocumentSummary[] };
    expect(docsAfterFailedSave.data.map((d) => d.title)).toEqual(["CORS"]);

    // 2) Failed saveSnapshot during removeDocument must keep the page in memory
    const failedRemove = await runtime.handleMessage({
      target: "offscreen",
      type: "REMOVE_DOC",
      doc_id: "https://fastapi.tiangolo.com/tutorial/cors",
    });
    expect(failedRemove.ok).toBe(false);
    const docsAfterFailedRemove = (await runtime.handleMessage({
      target: "offscreen",
      type: "LIST_DOCS",
    })) as { ok: true; data: DocumentSummary[] };
    expect(docsAfterFailedRemove.data.map((d) => d.title)).toEqual(["CORS"]);

    // 3) Failed clearSnapshot during clearIndex must NOT hide pages in memory
    failSave = false;
    failClear = true;
    const failedClear = await runtime.handleMessage({
      target: "offscreen",
      type: "CLEAR_INDEX",
    });
    expect(failedClear.ok).toBe(false);
    const docsAfterFailedClear = (await runtime.handleMessage({
      target: "offscreen",
      type: "LIST_DOCS",
    })) as { ok: true; data: DocumentSummary[] };
    expect(docsAfterFailedClear.data.map((d) => d.title)).toEqual(["CORS"]);
    const kwAfterFailedClear = (await runtime.handleMessage({
      target: "offscreen",
      type: "SEARCH",
      query: "Cross-Origin",
      mode: "keyword",
      top_k: 3,
    })) as { ok: true; data: SearchResponse };
    expect(kwAfterFailedClear.data.results).toHaveLength(1);

    runtime.dispose();
  });

  it("persists keyword-searchable text immediately even if AI model download fails offline", async () => {
    const store: { saved: StoredSnapshot | null } = { saved: null };
    const phases: Array<{ doc_id: string; phase: string; chunk_count: number }> = [];

    const runtime = new OffscreenRuntime({
      dim: 3,
      ensureWasm: async () => "0.1.0",
      loadSnapshot: async () => store.saved,
      saveSnapshot: async (json, stats) => {
        const meta = {
          updatedAtMs: Date.now(),
          byteLength: Buffer.byteLength(json, "utf8"),
          documentCount: stats.documentCount,
          chunkCount: stats.chunkCount,
        };
        store.saved = { key: "primary", json, meta };
        return meta;
      },
      clearSnapshot: async () => {
        store.saved = null;
      },
      embedText: async () => {
        throw new Error("Failed to fetch model: offline");
      },
      embedBatch: async () => {
        throw new Error("Failed to fetch model: offline");
      },
      onSavePhase: (update) => phases.push(update),
    });

    const resp = await runtime.handleMessage({
      target: "offscreen",
      type: "INDEX_PAGE",
      payload: {
        url: "https://example.com/offline-doc",
        title: "Offline Guide",
        markdown: "# Offline Guide\n\nIndexedDB keeps saved documentation searchable without internet.",
      },
    });
    expect(resp.ok).toBe(true);
    const metrics = (resp as { ok: true; data: IndexPageMetrics }).data;
    expect(metrics.chunk_count).toBe(1);
    expect(metrics.embeddings_status).toBe("failed");
    expect(metrics.embedding_error).toContain("offline");
    expect(phases).toEqual([
      { doc_id: "https://example.com/offline-doc", phase: "embedding", chunk_count: 1 },
    ]);
    expect(store.saved?.meta.documentCount).toBe(1);

    // Hybrid search degrades gracefully to keyword matches when offline
    const hybridResp = (await runtime.handleMessage({
      target: "offscreen",
      type: "SEARCH",
      query: "IndexedDB searchable",
      mode: "hybrid",
      top_k: 3,
    })) as { ok: true; data: SearchResponse };
    expect(hybridResp.ok).toBe(true);
    expect(hybridResp.data.degraded_to_keyword).toBe(true);
    expect(hybridResp.data.results[0].title).toBe("Offline Guide");

    // Semantic-only search returns a clear actionable error
    const semResp = await runtime.handleMessage({
      target: "offscreen",
      type: "SEARCH",
      query: "IndexedDB",
      mode: "semantic",
      top_k: 3,
    });
    expect(semResp.ok).toBe(false);

    // Fresh runtime after restart still has the offline-saved document
    runtime.dispose();
    const restarted = new OffscreenRuntime({
      dim: 3,
      ensureWasm: async () => "0.1.0",
      loadSnapshot: async () => store.saved,
      saveSnapshot: async () => {
        throw new Error("unused");
      },
      clearSnapshot: async () => {},
      embedText: async (t) => stubVector(t),
      embedBatch: async () => ({ flat: new Float32Array(0), dim: 3, elapsedMs: 0 }),
    });
    const kwAfterRestart = (await restarted.handleMessage({
      target: "offscreen",
      type: "SEARCH",
      query: "IndexedDB",
      mode: "keyword",
      top_k: 3,
    })) as { ok: true; data: SearchResponse };
    expect(kwAfterRestart.data.results[0].title).toBe("Offline Guide");
    restarted.dispose();
  });

  it("does not resurrect a deleted page if phase 2 embeddings finish after removal", async () => {
    const store: { saved: StoredSnapshot | null } = { saved: null };
    let finishEmbed!: (res: { flat: Float32Array; dim: number; elapsedMs: number }) => void;

    const runtime = new OffscreenRuntime({
      dim: 3,
      ensureWasm: async () => "0.1.0",
      loadSnapshot: async () => store.saved,
      saveSnapshot: async (json, stats) => {
        const meta = {
          updatedAtMs: Date.now(),
          byteLength: Buffer.byteLength(json, "utf8"),
          documentCount: stats.documentCount,
          chunkCount: stats.chunkCount,
        };
        store.saved = { key: "primary", json, meta };
        return meta;
      },
      clearSnapshot: async () => {
        store.saved = null;
      },
      embedText: async (t) => stubVector(t),
      embedBatch: () =>
        new Promise((resolve) => {
          finishEmbed = resolve;
        }),
    });

    const savePromise = runtime.handleMessage({
      target: "offscreen",
      type: "INDEX_PAGE",
      payload: {
        url: "https://example.com/transient",
        title: "Transient",
        markdown: "# Transient\n\nTemporary article to delete mid-embedding.",
      },
    });

    // Wait until Phase 1 has persisted the keyword entry
    await new Promise((r) => setTimeout(r, 20));
    expect(store.saved?.meta.documentCount).toBe(1);

    // User deletes the page before embeddings finish
    const rmResp = await runtime.handleMessage({
      target: "offscreen",
      type: "REMOVE_DOC",
      doc_id: "https://example.com/transient",
    });
    expect(rmResp.ok).toBe(true);
    expect(store.saved?.meta.documentCount).toBe(0);

    // Embeddings now resolve; must NOT re-insert the deleted page
    finishEmbed({ flat: new Float32Array([0.1, 0.2, 0.9]), dim: 3, elapsedMs: 5 });
    await savePromise;

    const docs = (await runtime.handleMessage({
      target: "offscreen",
      type: "LIST_DOCS",
    })) as { ok: true; data: DocumentSummary[] };
    expect(docs.data).toHaveLength(0);
    expect(store.saved?.meta.documentCount).toBe(0);
    runtime.dispose();
  });
});
