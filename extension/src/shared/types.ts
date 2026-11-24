export type ChunkingMode = "fixed" | "heading" | "sentence";
export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface DraftChunk {
  chunk_index: number;
  heading: string | null;
  text: string;
  anchor_phrase: string;
}

export interface DocumentSummary {
  doc_id: string;
  url: string;
  title: string;
  chunk_count: number;
  saved_at_ms: number;
}

export interface IndexStats {
  document_count: number;
  chunk_count: number;
  vector_count: number;
  vocab_size: number;
  embedding_dim: number;
  snapshot_bytes?: number;
}

export interface SearchResult {
  chunk_id: number;
  doc_id: string;
  url: string;
  jump_url: string;
  title: string;
  heading: string | null;
  text: string;
  anchor_phrase: string;
  score: number;
  bm25_rank: number | null;
  bm25_score: number | null;
  vector_rank: number | null;
  vector_score: number | null;
}

export interface PageExtractPayload {
  url: string;
  title: string;
  markdown: string;
}

export interface IndexPageMetrics {
  doc_id: string;
  chunk_count: number;
  chunk_ms: number;
  embed_ms: number;
  index_ms: number;
  persist_ms: number;
  total_ms: number;
  snapshot_bytes: number;
}

export interface SearchResponse {
  results: SearchResult[];
  embed_ms: number;
  search_ms: number;
  total_ms: number;
}

export type OffscreenRequest =
  | { target: "offscreen"; type: "PING" }
  | { target: "offscreen"; type: "GET_STATS" }
  | { target: "offscreen"; type: "LIST_DOCS" }
  | {
      target: "offscreen";
      type: "INDEX_PAGE";
      payload: PageExtractPayload & { strategy?: ChunkingMode };
    }
  | {
      target: "offscreen";
      type: "REMOVE_DOC";
      doc_id: string;
    }
  | {
      target: "offscreen";
      type: "CLEAR_INDEX";
    }
  | {
      target: "offscreen";
      type: "SEARCH";
      query: string;
      mode: SearchMode;
      top_k: number;
    };

export interface ModelProgressBroadcast {
  target: "popup";
  type: "MODEL_PROGRESS";
  status: string;
  file?: string;
  progress?: number;
}

export interface ActiveTabStatus {
  url: string | null;
  saveable: boolean;
  already_saved: boolean;
}

export type PopupRequest =
  | { target: "background"; type: "GET_STATS" }
  | { target: "background"; type: "GET_ACTIVE_TAB_STATUS" }
  | { target: "background"; type: "LIST_DOCS" }
  | { target: "background"; type: "SAVE_ACTIVE_TAB"; strategy?: ChunkingMode }
  | { target: "background"; type: "REMOVE_DOC"; doc_id: string }
  | { target: "background"; type: "CLEAR_INDEX" }
  | { target: "background"; type: "SEARCH"; query: string; mode: SearchMode; top_k: number }
  | { target: "background"; type: "OPEN_RESULT"; url: string; jump_url: string; anchor_phrase: string };

export type MessageResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };
