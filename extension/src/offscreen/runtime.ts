import type {
  ChunkingMode,
  DocumentSummary,
  IndexPageMetrics,
  IndexStats,
  MessageResponse,
  OffscreenRequest,
  PageExtractPayload,
  SearchMode,
  SearchResponse,
} from "../shared/types";
import { chunkText, EMBEDDING_DIM, ensureWasmReady, RecallEngine } from "../shared/wasm";
import { loadSnapshot, saveSnapshot, type SnapshotMeta, type StoredSnapshot } from "../storage/idb";
import { embedBatch, embedText, type BatchEmbedResult } from "./embedder";

export interface RuntimeDeps {
  ensureWasm: () => Promise<string>;
  loadSnapshot: () => Promise<StoredSnapshot | null>;
  saveSnapshot: (
    json: string,
    stats: { documentCount: number; chunkCount: number }
  ) => Promise<SnapshotMeta>;
  embedText: (text: string) => Promise<Float32Array>;
  embedBatch: (texts: string[], batchSize?: number) => Promise<BatchEmbedResult>;
  now: () => number;
  dim: number;
}

const DEFAULT_DEPS: RuntimeDeps = {
  ensureWasm: () => ensureWasmReady(),
  loadSnapshot: () => loadSnapshot(),
  saveSnapshot: (json, stats) => saveSnapshot(json, stats),
  embedText: (text) => embedText(text),
  embedBatch: (texts, batchSize) => embedBatch(texts, batchSize),
  now: () => performance.now(),
  dim: EMBEDDING_DIM,
};

/**
 * Strips URL hash fragments and normalizes trailing slashes so re-saving the same page
 * from a `#:~:text=` jump link updates the existing document rather than creating a duplicate.
 */
export function normalizeUrlToDocId(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${pathname}${parsed.search}`;
  } catch {
    return rawUrl.split("#")[0].replace(/\/+$/, "");
  }
}

export class OffscreenRuntime {
  private readonly deps: RuntimeDeps;
  private engine: RecallEngine | null = null;
  private initPromise: Promise<RecallEngine> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(overrides: Partial<RuntimeDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...overrides };
  }

  private async getEngine(): Promise<RecallEngine> {
    if (this.engine) return this.engine;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.deps.ensureWasm();
        const saved = await this.deps.loadSnapshot();
        const engine = saved?.json
          ? RecallEngine.fromSnapshot(saved.json)
          : RecallEngine.create(this.deps.dim);
        this.engine = engine;
        return engine;
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async handleMessage(msg: OffscreenRequest): Promise<MessageResponse> {
    try {
      switch (msg.type) {
        case "PING": {
          const version = await this.deps.ensureWasm();
          return { ok: true, data: { status: "ready", core_version: version } };
        }
        case "GET_STATS": {
          const engine = await this.getEngine();
          return { ok: true, data: engine.stats() satisfies IndexStats };
        }
        case "LIST_DOCS": {
          const engine = await this.getEngine();
          return { ok: true, data: engine.listDocuments() satisfies DocumentSummary[] };
        }
        case "INDEX_PAGE": {
          const data = await this.indexPage(msg.payload);
          return { ok: true, data };
        }
        case "REMOVE_DOC": {
          const removed = await this.removeDocument(msg.doc_id);
          return { ok: true, data: { removed } };
        }
        case "SEARCH": {
          const data = await this.search(msg.query, msg.mode, msg.top_k);
          return { ok: true, data };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async indexPage(
    payload: PageExtractPayload & { strategy?: ChunkingMode }
  ): Promise<IndexPageMetrics> {
    return this.enqueueWrite(async () => {
      const tStart = this.deps.now();
      const engine = await this.getEngine();
      const strategy = payload.strategy ?? "heading";
      const docId = normalizeUrlToDocId(payload.url);
      const canonicalUrl = docId;

      const tChunkStart = this.deps.now();
      const chunks = chunkText(payload.markdown, strategy);
      const chunkMs = this.deps.now() - tChunkStart;

      if (chunks.length === 0) {
        throw new Error("no readable text extracted from this page");
      }

      const textsToEmbed = chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text));
      const embedResult = await this.deps.embedBatch(textsToEmbed, 8);

      const tIndexStart = this.deps.now();
      const chunkCount = engine.upsertDocument(
        docId,
        canonicalUrl,
        payload.title || canonicalUrl,
        Date.now(),
        chunks,
        embedResult.flat
      );
      const indexMs = this.deps.now() - tIndexStart;

      const tPersistStart = this.deps.now();
      const snapshot = engine.toSnapshot();
      const stats = engine.stats();
      const meta = await this.deps.saveSnapshot(snapshot, {
        documentCount: stats.document_count,
        chunkCount: stats.chunk_count,
      });
      const persistMs = this.deps.now() - tPersistStart;

      return {
        doc_id: docId,
        chunk_count: chunkCount,
        chunk_ms: round2(chunkMs),
        embed_ms: round2(embedResult.elapsedMs),
        index_ms: round2(indexMs),
        persist_ms: round2(persistMs),
        total_ms: round2(this.deps.now() - tStart),
        snapshot_bytes: meta.byteLength,
      };
    });
  }

  async removeDocument(docId: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const engine = await this.getEngine();
      const removed = engine.removeDocument(docId);
      if (removed) {
        const snapshot = engine.toSnapshot();
        const stats = engine.stats();
        await this.deps.saveSnapshot(snapshot, {
          documentCount: stats.document_count,
          chunkCount: stats.chunk_count,
        });
      }
      return removed;
    });
  }

  async search(query: string, mode: SearchMode, topK: number): Promise<SearchResponse> {
    const tStart = this.deps.now();
    const engine = await this.getEngine();
    const trimmed = query.trim();
    if (!trimmed) {
      return { results: [], embed_ms: 0, search_ms: 0, total_ms: 0 };
    }

    if (mode === "keyword") {
      const tSearch = this.deps.now();
      const results = engine.searchKeyword(trimmed, topK);
      const searchMs = this.deps.now() - tSearch;
      return {
        results,
        embed_ms: 0,
        search_ms: round3(searchMs),
        total_ms: round3(this.deps.now() - tStart),
      };
    }

    const tEmbed = this.deps.now();
    const queryVec = await this.deps.embedText(trimmed);
    const embedMs = this.deps.now() - tEmbed;

    const tSearch = this.deps.now();
    const results =
      mode === "semantic"
        ? engine.searchSemantic(queryVec, topK)
        : engine.searchHybrid(trimmed, queryVec, topK);
    const searchMs = this.deps.now() - tSearch;

    return {
      results,
      embed_ms: round2(embedMs),
      search_ms: round3(searchMs),
      total_ms: round2(this.deps.now() - tStart),
    };
  }

  dispose(): void {
    this.engine?.free();
    this.engine = null;
    this.initPromise = null;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
