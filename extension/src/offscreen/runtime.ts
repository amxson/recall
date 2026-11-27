import type {
  ChunkingMode,
  DocumentSummary,
  IndexPageMetrics,
  IndexStats,
  MessageResponse,
  PageExtractPayload,
  RuntimeRequest,
  SearchMode,
  SearchResponse,
} from "../shared/types";
import { normalizeUrlToDocId } from "../shared/url";
import { chunkText, EMBEDDING_DIM, ensureWasmReady, RecallEngine } from "../shared/wasm";
import {
  clearSnapshot,
  loadSnapshot,
  saveSnapshot,
  type SnapshotMeta,
  type StoredSnapshot,
} from "../storage/idb";
import { embedBatch, embedText, type BatchEmbedResult } from "./embedder";

export { normalizeUrlToDocId };

export interface SavePhaseUpdate {
  doc_id: string;
  phase: "embedding";
  chunk_count: number;
}

export interface RuntimeDeps {
  ensureWasm: () => Promise<string>;
  loadSnapshot: () => Promise<StoredSnapshot | null>;
  saveSnapshot: (
    json: string,
    stats: { documentCount: number; chunkCount: number }
  ) => Promise<SnapshotMeta>;
  clearSnapshot: () => Promise<void>;
  embedText: (text: string) => Promise<Float32Array>;
  embedBatch: (texts: string[], batchSize?: number) => Promise<BatchEmbedResult>;
  onSavePhase?: (update: SavePhaseUpdate) => void;
  now: () => number;
  dim: number;
}

const DEFAULT_DEPS: RuntimeDeps = {
  ensureWasm: () => ensureWasmReady(),
  loadSnapshot: () => loadSnapshot(),
  saveSnapshot: (json, stats) => saveSnapshot(json, stats),
  clearSnapshot: () => clearSnapshot(),
  embedText: (text) => embedText(text),
  embedBatch: (texts, batchSize) => embedBatch(texts, batchSize),
  now: () => performance.now(),
  dim: EMBEDDING_DIM,
};

export class OffscreenRuntime {
  private readonly deps: RuntimeDeps;
  private engine: RecallEngine | null = null;
  private initPromise: Promise<RecallEngine> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private snapshotBytes = 0;
  private clearGeneration = 0;
  private docRevisionSeq = 0;
  private readonly docRevisions = new Map<string, number>();

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
        this.snapshotBytes = saved?.meta.byteLength ?? 0;
        this.engine = engine;
        return engine;
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private restoreEngine(previousSnapshot: string, previousBytes: number): void {
    const restored = RecallEngine.fromSnapshot(previousSnapshot);
    if (this.engine) {
      this.engine.free();
    }
    this.engine = restored;
    this.initPromise = Promise.resolve(restored);
    this.snapshotBytes = previousBytes;
  }

  private async persistCurrentEngine(
    engine: RecallEngine,
    previousSnapshot: string,
    previousBytes: number
  ): Promise<SnapshotMeta> {
    const snapshot = engine.toSnapshot();
    const stats = engine.stats();
    try {
      const meta = await this.deps.saveSnapshot(snapshot, {
        documentCount: stats.document_count,
        chunkCount: stats.chunk_count,
      });
      this.snapshotBytes = meta.byteLength;
      return meta;
    } catch (err) {
      this.restoreEngine(previousSnapshot, previousBytes);
      throw err;
    }
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async handleMessage(msg: RuntimeRequest): Promise<MessageResponse> {
    try {
      switch (msg.type) {
        case "PING": {
          const version = await this.deps.ensureWasm();
          return { ok: true, data: { status: "ready", core_version: version } };
        }
        case "GET_STATS": {
          const engine = await this.getEngine();
          const stats: IndexStats = {
            ...engine.stats(),
            snapshot_bytes: this.snapshotBytes,
          };
          return { ok: true, data: stats };
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
        case "CLEAR_INDEX": {
          await this.clearIndex();
          return { ok: true, data: { cleared: true } };
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
    const tStart = this.deps.now();
    const strategy = payload.strategy ?? "heading";
    const docId = normalizeUrlToDocId(payload.url);
    const canonicalUrl = docId;
    const title = payload.title || canonicalUrl;
    const savedAtMs = Date.now();

    // Phase 1: Chunk and persist keyword-searchable text immediately before touching the AI model.
    const phase1 = await this.enqueueWrite(async () => {
      const engine = await this.getEngine();

      const tChunkStart = this.deps.now();
      const chunks = chunkText(payload.markdown, strategy);
      const chunkMs = this.deps.now() - tChunkStart;

      if (chunks.length === 0) {
        throw new Error("no readable text extracted from this page");
      }

      const prevSnapshot = engine.toSnapshot();
      const prevBytes = this.snapshotBytes;

      const tIndexStart = this.deps.now();
      const chunkCount = engine.upsertDocument(
        docId,
        canonicalUrl,
        title,
        savedAtMs,
        chunks,
        new Float32Array(0)
      );
      const indexMs = this.deps.now() - tIndexStart;

      const tPersistStart = this.deps.now();
      const meta = await this.persistCurrentEngine(engine, prevSnapshot, prevBytes);
      const persistMs = this.deps.now() - tPersistStart;

      const revision = ++this.docRevisionSeq;
      this.docRevisions.set(docId, revision);

      return {
        chunks,
        chunkCount,
        chunkMs,
        indexMs,
        persistMs,
        snapshotBytes: meta.byteLength,
        revision,
        clearGen: this.clearGeneration,
      };
    });

    this.deps.onSavePhase?.({
      doc_id: docId,
      phase: "embedding",
      chunk_count: phase1.chunkCount,
    });

    // Phase 2: Compute dense embeddings without holding the write lock, then upgrade atomically.
    const textsToEmbed = phase1.chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text));
    let embedResult: BatchEmbedResult;
    try {
      // Single-passage batches avoid padding waste on 1-thread WASM and keep mid-index search/status responsive.
      embedResult = await this.deps.embedBatch(textsToEmbed, 1);
    } catch (err) {
      const embeddingError = err instanceof Error ? err.message : String(err);
      return {
        doc_id: docId,
        chunk_count: phase1.chunkCount,
        chunk_ms: round2(phase1.chunkMs),
        embed_ms: 0,
        index_ms: round2(phase1.indexMs),
        persist_ms: round2(phase1.persistMs),
        total_ms: round2(this.deps.now() - tStart),
        snapshot_bytes: phase1.snapshotBytes,
        embeddings_status: "failed",
        embedding_error: embeddingError,
      };
    }

    return this.enqueueWrite(async () => {
      // Skip committing stale embeddings if the document was removed, re-saved, or the index was cleared.
      if (
        this.clearGeneration !== phase1.clearGen ||
        this.docRevisions.get(docId) !== phase1.revision
      ) {
        return {
          doc_id: docId,
          chunk_count: phase1.chunkCount,
          chunk_ms: round2(phase1.chunkMs),
          embed_ms: round2(embedResult.elapsedMs),
          index_ms: round2(phase1.indexMs),
          persist_ms: round2(phase1.persistMs),
          total_ms: round2(this.deps.now() - tStart),
          snapshot_bytes: this.snapshotBytes,
          embeddings_status: "ready",
        };
      }

      const engine = await this.getEngine();
      const prevSnapshot = engine.toSnapshot();
      const prevBytes = this.snapshotBytes;

      const tIndexStart = this.deps.now();
      const chunkCount = engine.upsertDocument(
        docId,
        canonicalUrl,
        title,
        savedAtMs,
        phase1.chunks,
        embedResult.flat
      );
      const indexMs = phase1.indexMs + (this.deps.now() - tIndexStart);

      const tPersistStart = this.deps.now();
      try {
        const meta = await this.persistCurrentEngine(engine, prevSnapshot, prevBytes);
        const persistMs = phase1.persistMs + (this.deps.now() - tPersistStart);
        return {
          doc_id: docId,
          chunk_count: chunkCount,
          chunk_ms: round2(phase1.chunkMs),
          embed_ms: round2(embedResult.elapsedMs),
          index_ms: round2(indexMs),
          persist_ms: round2(persistMs),
          total_ms: round2(this.deps.now() - tStart),
          snapshot_bytes: meta.byteLength,
          embeddings_status: "ready",
        };
      } catch (err) {
        // Phase 1 keyword data was restored cleanly; report semantic persistence failure honestly.
        const embeddingError = err instanceof Error ? err.message : String(err);
        return {
          doc_id: docId,
          chunk_count: phase1.chunkCount,
          chunk_ms: round2(phase1.chunkMs),
          embed_ms: round2(embedResult.elapsedMs),
          index_ms: round2(phase1.indexMs),
          persist_ms: round2(phase1.persistMs),
          total_ms: round2(this.deps.now() - tStart),
          snapshot_bytes: this.snapshotBytes,
          embeddings_status: "failed",
          embedding_error: `Saved keyword index, but failed to store vectors: ${embeddingError}`,
        };
      }
    });
  }

  async removeDocument(docId: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const engine = await this.getEngine();
      const prevSnapshot = engine.toSnapshot();
      const prevBytes = this.snapshotBytes;

      const removed = engine.removeDocument(docId);
      if (removed) {
        await this.persistCurrentEngine(engine, prevSnapshot, prevBytes);
        this.docRevisions.delete(docId);
      }
      return removed;
    });
  }

  async clearIndex(): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.deps.ensureWasm();
      // Persist deletion in IndexedDB first so a storage failure never hides pages in memory.
      await this.deps.clearSnapshot();
      if (this.engine) {
        this.engine.free();
      }
      this.engine = RecallEngine.create(this.deps.dim);
      this.initPromise = Promise.resolve(this.engine);
      this.snapshotBytes = 0;
      this.clearGeneration += 1;
      this.docRevisions.clear();
    });
  }

  async search(query: string, mode: SearchMode, topK: number): Promise<SearchResponse> {
    const tStart = this.deps.now();
    const trimmed = query.trim();
    if (!trimmed) {
      await this.getEngine();
      return { results: [], embed_ms: 0, search_ms: 0, total_ms: 0 };
    }

    if (mode === "keyword") {
      const engine = await this.getEngine();
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

    // Ensure the index is hydrated first, then reacquire after awaiting embeddings
    // so concurrent clearIndex() or storage rollback cannot leave a freed WASM handle.
    await this.getEngine();

    let queryVec: Float32Array;
    let embedMs = 0;
    try {
      const tEmbed = this.deps.now();
      queryVec = await this.deps.embedText(trimmed);
      embedMs = this.deps.now() - tEmbed;
    } catch (err) {
      if (mode === "hybrid") {
        const currentEngine = await this.getEngine();
        const tSearch = this.deps.now();
        const results = currentEngine.searchKeyword(trimmed, topK);
        const searchMs = this.deps.now() - tSearch;
        return {
          results,
          embed_ms: 0,
          search_ms: round3(searchMs),
          total_ms: round3(this.deps.now() - tStart),
          degraded_to_keyword: true,
          warning: "Local AI model unavailable — showing keyword matches.",
        };
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Semantic search needs the local AI model (${detail}). Switch to Keyword or Hybrid mode.`
      );
    }

    const currentEngine = await this.getEngine();
    const tSearch = this.deps.now();
    const results =
      mode === "semantic"
        ? currentEngine.searchSemantic(queryVec, topK)
        : currentEngine.searchHybrid(trimmed, queryVec, topK);
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
