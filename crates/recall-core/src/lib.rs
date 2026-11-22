//! Core local hybrid search library for Recall.

pub mod bm25;
pub mod chunker;
pub mod error;
pub mod tokenizer;
pub mod vector;

pub use bm25::{Bm25Index, Bm25Params, ChunkId, RankedHit};
pub use chunker::{chunk_document, ChunkingStrategy, DraftChunk};
pub use error::RecallError;
pub use tokenizer::{tokenize, TokenizerConfig};
pub use vector::VectorStore;
