use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::bm25::{ChunkId, RankedHit};
use crate::error::RecallError;

/// Contiguous brute-force dense vector store using L2-normalized vectors.
///
/// Storing all embeddings in a single flat `Vec<f32>` keeps linear scans cache-friendly
/// and supports O(1) swap-remove deletions without leaving tombstones behind.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorStore {
    dim: usize,
    ids: Vec<ChunkId>,
    data: Vec<f32>,
    #[serde(skip)]
    pos_by_id: HashMap<ChunkId, usize>,
}

impl VectorStore {
    pub fn new(dim: usize) -> Result<Self, RecallError> {
        if dim == 0 {
            return Err(RecallError::InvalidConfig(
                "embedding dimension must be greater than zero".into(),
            ));
        }
        Ok(Self {
            dim,
            ids: Vec::new(),
            data: Vec::new(),
            pos_by_id: HashMap::new(),
        })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// Rebuilds the internal id->slot lookup table after deserialization.
    pub fn rebuild_lookup(&mut self) {
        self.pos_by_id.clear();
        self.pos_by_id.reserve(self.ids.len());
        for (slot, &id) in self.ids.iter().enumerate() {
            self.pos_by_id.insert(id, slot);
        }
    }

    pub fn upsert(&mut self, chunk_id: ChunkId, vector: &[f32]) -> Result<(), RecallError> {
        let normalized = normalize_checked(vector, self.dim)?;

        if let Some(&slot) = self.pos_by_id.get(&chunk_id) {
            let start = slot * self.dim;
            self.data[start..start + self.dim].copy_from_slice(&normalized);
            return Ok(());
        }

        let slot = self.ids.len();
        self.ids.push(chunk_id);
        self.data.extend_from_slice(&normalized);
        self.pos_by_id.insert(chunk_id, slot);
        Ok(())
    }

    pub fn remove(&mut self, chunk_id: ChunkId) -> bool {
        let Some(slot) = self.pos_by_id.remove(&chunk_id) else {
            return false;
        };

        let last_slot = self.ids.len() - 1;
        if slot != last_slot {
            let moved_id = self.ids[last_slot];
            self.ids[slot] = moved_id;

            let dst = slot * self.dim;
            let src = last_slot * self.dim;
            self.data.copy_within(src..src + self.dim, dst);
            self.pos_by_id.insert(moved_id, slot);
        }

        self.ids.pop();
        self.data.truncate(last_slot * self.dim);
        true
    }

    pub fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<RankedHit>, RecallError> {
        if top_k == 0 || self.ids.is_empty() {
            // Still validate query shape so callers notice bad inputs immediately
            let _ = normalize_checked(query, self.dim)?;
            return Ok(Vec::new());
        }

        let q = normalize_checked(query, self.dim)?;
        if q.iter().all(|&v| v == 0.0) {
            return Ok(Vec::new());
        }

        let mut hits: Vec<RankedHit> = self
            .ids
            .iter()
            .zip(self.data.chunks_exact(self.dim))
            .map(|(&chunk_id, vec)| RankedHit {
                chunk_id,
                score: dot_product(&q, vec),
            })
            .collect();

        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.chunk_id.cmp(&b.chunk_id))
        });

        hits.truncate(top_k);
        Ok(hits)
    }
}

fn normalize_checked(vector: &[f32], expected_dim: usize) -> Result<Vec<f32>, RecallError> {
    if vector.len() != expected_dim {
        return Err(RecallError::DimensionMismatch {
            expected: expected_dim,
            got: vector.len(),
        });
    }

    let mut norm_sq = 0.0_f32;
    for &v in vector {
        if !v.is_finite() {
            return Err(RecallError::NonFiniteEmbedding);
        }
        norm_sq += v * v;
    }

    let norm = norm_sq.sqrt();
    if norm == 0.0 {
        return Ok(vec![0.0; expected_dim]);
    }

    let inv = 1.0 / norm;
    Ok(vector.iter().map(|&v| v * inv).collect())
}

#[inline]
fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_vectors_by_cosine_similarity_regardless_of_scale() {
        let mut store = VectorStore::new(3).unwrap();
        store.upsert(10, &[1.0, 0.0, 0.0]).unwrap();
        store.upsert(20, &[0.0, 1.0, 0.0]).unwrap();
        store.upsert(30, &[10.0, 10.0, 0.0]).unwrap();

        let hits = store.search(&[5.0, 0.5, 0.0], 3).unwrap();
        assert_eq!(hits[0].chunk_id, 10);
        assert_eq!(hits[1].chunk_id, 30);
        assert_eq!(hits[2].chunk_id, 20);
        assert!(hits[0].score > 0.99);
    }

    #[test]
    fn validates_dimension_and_finiteness() {
        let mut store = VectorStore::new(4).unwrap();
        assert!(matches!(
            store.upsert(1, &[1.0, 2.0]),
            Err(RecallError::DimensionMismatch {
                expected: 4,
                got: 2
            })
        ));
        assert!(matches!(
            store.upsert(1, &[1.0, f32::NAN, 0.0, 0.0]),
            Err(RecallError::NonFiniteEmbedding)
        ));
    }

    #[test]
    fn swap_remove_preserves_alignment_of_remaining_vectors() {
        let mut store = VectorStore::new(2).unwrap();
        store.upsert(0, &[1.0, 0.0]).unwrap();
        store.upsert(1, &[0.0, 1.0]).unwrap();
        store.upsert(2, &[-1.0, 0.0]).unwrap();

        assert!(store.remove(0));
        assert!(!store.remove(0));
        assert_eq!(store.len(), 2);

        let hits = store.search(&[-1.0, 0.0], 2).unwrap();
        assert_eq!(hits[0].chunk_id, 2);
        assert!((hits[0].score - 1.0).abs() < 1e-5);
        assert_eq!(hits[1].chunk_id, 1);
    }

    #[test]
    fn handles_zero_norm_query_without_nan() {
        let mut store = VectorStore::new(2).unwrap();
        store.upsert(0, &[1.0, 0.0]).unwrap();
        let hits = store.search(&[0.0, 0.0], 5).unwrap();
        assert!(hits.is_empty());
    }
}
