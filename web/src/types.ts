export type SearchMode = "hybrid" | "keyword" | "semantic";

export interface IndexStats {
  document_count: number;
  chunk_count: number;
  vector_count: number;
  vocab_size: number;
  embedding_dim: number;
}

export interface SearchHit {
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

export interface DemoPreset {
  id: string;
  category: "exact" | "conceptual" | "mixed" | "hard";
  query: string;
  expected_docs: string[];
  embedding: number[];
}

export interface CategoryScore {
  count: number;
  recall_at_1: number;
  recall_at_5: number;
  mrr_at_10: number;
  ndcg_at_10: number;
}

export interface BenchmarkRow {
  method: "bm25" | "vector" | "hybrid";
  strategy: "fixed" | "heading" | "sentence";
  chunks: number;
  recall_at_1: number;
  recall_at_5: number;
  mrr_at_10: number;
  ndcg_at_10: number;
  p50_ms: number;
  p95_ms: number;
  misses_at_5_count: number;
  by_category: Record<string, CategoryScore>;
}

export interface WinExample {
  id: string;
  category: string;
  query: string;
  expected: string[];
  bm25_rank: number | null;
  vector_rank: number | null;
  hybrid_rank: number | null;
  vector_top1?: string | null;
  bm25_top1?: string | null;
}

export interface BenchmarkBundle {
  generated_at: string;
  corpus: {
    source_repo: string;
    tag: string;
    commit_sha: string;
    documents: number;
    total_words: number;
  };
  queries: {
    count: number;
    categories: Record<string, number>;
  };
  environment: {
    model: string;
    dtype: string;
    rrf_k: number;
    node: string;
    platform: string;
    cpu: string;
  };
  summary_table: BenchmarkRow[];
  head_to_head_heading: {
    strategy: string;
    hybrid_beats_bm25_mrr: number;
    bm25_beats_hybrid_mrr: number;
    hybrid_ties_bm25_mrr: number;
    hybrid_beats_vector_mrr: number;
    vector_beats_hybrid_mrr: number;
    hybrid_ties_vector_mrr: number;
    bm25_wins_examples: WinExample[];
    vector_wins_examples: WinExample[];
  };
  criterion_native: Array<{
    passages: number;
    bm25_ms: number;
    cosine_ms: number;
    hybrid_ms: number;
  }>;
}
