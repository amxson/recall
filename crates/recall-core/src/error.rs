use thiserror::Error;

#[derive(Debug, Error)]
pub enum RecallError {
    #[error("embedding dimension mismatch: expected {expected}, got {got}")]
    DimensionMismatch { expected: usize, got: usize },

    #[error("invalid embedding vector: contains non-finite value")]
    NonFiniteEmbedding,

    #[error("invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}
