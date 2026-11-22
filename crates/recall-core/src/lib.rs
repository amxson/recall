//! Core local hybrid search library for Recall.

pub mod bm25;
pub mod chunker;
pub mod error;
pub mod fusion;
pub mod index;
pub mod tokenizer;
pub mod vector;

pub use bm25::{Bm25Index, Bm25Params, ChunkId, RankedHit};
pub use chunker::{chunk_document, ChunkingStrategy, DraftChunk};
pub use error::RecallError;
pub use fusion::{reciprocal_rank_fusion, FusedHit, DEFAULT_RRF_K};
pub use index::{
    build_text_fragment_url, DocumentSummary, IndexStats, RecallIndex, SearchResult, StoredChunk,
};
pub use tokenizer::{tokenize, TokenizerConfig};
pub use vector::VectorStore;
