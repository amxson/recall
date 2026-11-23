import initWasm, { WasmRecallIndex, chunk_text_json, core_version } from "../wasm/recall_wasm";
import type { ChunkingMode, DocumentSummary, DraftChunk, IndexStats, SearchResult } from "./types";

export const EMBEDDING_DIM = 384;

let initialized = false;

export async function ensureWasmReady(wasmUrl?: string | URL): Promise<string> {
  if (!initialized) {
    await initWasm(wasmUrl ? { module_or_path: wasmUrl } : undefined);
    initialized = true;
  }
  return core_version();
}

export function chunkText(text: string, strategy: ChunkingMode = "heading"): DraftChunk[] {
  return JSON.parse(chunk_text_json(text, strategy)) as DraftChunk[];
}

export class RecallEngine {
  private inner: WasmRecallIndex;

  private constructor(inner: WasmRecallIndex) {
    this.inner = inner;
  }

  static create(dim: number = EMBEDDING_DIM): RecallEngine {
    return new RecallEngine(new WasmRecallIndex(dim));
  }

  static fromSnapshot(json: string): RecallEngine {
    return new RecallEngine(WasmRecallIndex.from_json(json));
  }

  toSnapshot(): string {
    return this.inner.to_json();
  }

  upsertDocument(
    docId: string,
    url: string,
    title: string,
    savedAtMs: number,
    chunks: DraftChunk[],
    flatEmbeddings: Float32Array
  ): number {
    return this.inner.upsert_document(
      docId,
      url,
      title,
      savedAtMs,
      JSON.stringify(chunks),
      flatEmbeddings
    );
  }

  removeDocument(docId: string): boolean {
    return this.inner.remove_document(docId);
  }

  removeByUrl(url: string): boolean {
    return this.inner.remove_by_url(url);
  }

  stats(): IndexStats {
    return JSON.parse(this.inner.stats_json()) as IndexStats;
  }

  listDocuments(): DocumentSummary[] {
    return JSON.parse(this.inner.list_documents_json()) as DocumentSummary[];
  }

  searchKeyword(query: string, topK: number = 8): SearchResult[] {
    return JSON.parse(this.inner.search_keyword_json(query, topK)) as SearchResult[];
  }

  searchSemantic(queryEmbedding: Float32Array, topK: number = 8): SearchResult[] {
    return JSON.parse(this.inner.search_semantic_json(queryEmbedding, topK)) as SearchResult[];
  }

  searchHybrid(
    query: string,
    queryEmbedding: Float32Array,
    topK: number = 8,
    rrfK?: number
  ): SearchResult[] {
    return JSON.parse(
      this.inner.search_hybrid_json(query, queryEmbedding, topK, rrfK)
    ) as SearchResult[];
  }

  free(): void {
    this.inner.free();
  }
}
