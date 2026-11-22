use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::bm25::{ChunkId, RankedHit};

pub const DEFAULT_RRF_K: f32 = 60.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct FusedHit {
    pub chunk_id: ChunkId,
    pub score: f32,
    pub bm25_rank: Option<usize>,
    pub bm25_score: Option<f32>,
    pub vector_rank: Option<usize>,
    pub vector_score: Option<f32>,
}

/// Combines keyword and semantic ranked lists via Reciprocal Rank Fusion:
/// `score(d) = sum(1 / (k + rank_i(d)))`, where ranks are 1-indexed.
pub fn reciprocal_rank_fusion(
    bm25_hits: &[RankedHit],
    vector_hits: &[RankedHit],
    k: f32,
    top_k: usize,
) -> Vec<FusedHit> {
    if top_k == 0 {
        return Vec::new();
    }
    let k = if k.is_finite() && k > 0.0 {
        k
    } else {
        DEFAULT_RRF_K
    };

    let mut merged: HashMap<ChunkId, FusedHit> = HashMap::new();

    for (idx, hit) in bm25_hits.iter().enumerate() {
        let rank = idx + 1;
        let contrib = 1.0 / (k + rank as f32);
        let entry = merged.entry(hit.chunk_id).or_insert(FusedHit {
            chunk_id: hit.chunk_id,
            score: 0.0,
            bm25_rank: None,
            bm25_score: None,
            vector_rank: None,
            vector_score: None,
        });
        entry.score += contrib;
        entry.bm25_rank = Some(rank);
        entry.bm25_score = Some(hit.score);
    }

    for (idx, hit) in vector_hits.iter().enumerate() {
        let rank = idx + 1;
        let contrib = 1.0 / (k + rank as f32);
        let entry = merged.entry(hit.chunk_id).or_insert(FusedHit {
            chunk_id: hit.chunk_id,
            score: 0.0,
            bm25_rank: None,
            bm25_score: None,
            vector_rank: None,
            vector_score: None,
        });
        entry.score += contrib;
        entry.vector_rank = Some(rank);
        entry.vector_score = Some(hit.score);
    }

    let mut results: Vec<FusedHit> = merged.into_values().collect();
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.chunk_id.cmp(&b.chunk_id))
    });
    results.truncate(top_k);
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boosts_chunks_present_in_both_lists() {
        let bm25 = vec![
            RankedHit {
                chunk_id: 1,
                score: 9.5,
            },
            RankedHit {
                chunk_id: 2,
                score: 6.1,
            },
            RankedHit {
                chunk_id: 3,
                score: 4.0,
            },
        ];
        let vector = vec![
            RankedHit {
                chunk_id: 4,
                score: 0.91,
            },
            RankedHit {
                chunk_id: 2,
                score: 0.87,
            },
            RankedHit {
                chunk_id: 5,
                score: 0.72,
            },
        ];

        let fused = reciprocal_rank_fusion(&bm25, &vector, DEFAULT_RRF_K, 5);
        assert_eq!(fused[0].chunk_id, 2);
        assert_eq!(fused[0].bm25_rank, Some(2));
        assert_eq!(fused[0].vector_rank, Some(2));
        let expected = 2.0 / (DEFAULT_RRF_K + 2.0);
        assert!((fused[0].score - expected).abs() < 1e-6);
    }

    #[test]
    fn works_when_one_retriever_returns_empty() {
        let vector = vec![
            RankedHit {
                chunk_id: 9,
                score: 0.82,
            },
            RankedHit {
                chunk_id: 3,
                score: 0.71,
            },
        ];
        let fused = reciprocal_rank_fusion(&[], &vector, DEFAULT_RRF_K, 2);
        assert_eq!(fused.len(), 2);
        assert_eq!(fused[0].chunk_id, 9);
        assert!(fused[0].bm25_rank.is_none());
        assert_eq!(fused[0].vector_rank, Some(1));
    }
}
