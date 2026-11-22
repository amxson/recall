use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::bm25::{Bm25Index, Bm25Params, ChunkId, RankedHit};
use crate::chunker::DraftChunk;
use crate::error::RecallError;
use crate::fusion::{reciprocal_rank_fusion, FusedHit, DEFAULT_RRF_K};
use crate::tokenizer::TokenizerConfig;
use crate::vector::VectorStore;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredChunk {
    pub id: ChunkId,
    pub doc_id: String,
    pub url: String,
    pub title: String,
    pub heading: Option<String>,
    pub text: String,
    pub anchor_phrase: String,
    pub saved_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentSummary {
    pub doc_id: String,
    pub url: String,
    pub title: String,
    pub chunk_count: usize,
    pub saved_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexStats {
    pub document_count: usize,
    pub chunk_count: usize,
    pub vector_count: usize,
    pub vocab_size: usize,
    pub embedding_dim: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchResult {
    pub chunk_id: ChunkId,
    pub doc_id: String,
    pub url: String,
    pub jump_url: String,
    pub title: String,
    pub heading: Option<String>,
    pub text: String,
    pub anchor_phrase: String,
    pub score: f32,
    pub bm25_rank: Option<usize>,
    pub bm25_score: Option<f32>,
    pub vector_rank: Option<usize>,
    pub vector_score: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecallIndex {
    next_chunk_id: ChunkId,
    chunks: HashMap<ChunkId, StoredChunk>,
    doc_chunks: HashMap<String, Vec<ChunkId>>,
    bm25: Bm25Index,
    vectors: VectorStore,
}

impl RecallIndex {
    pub fn new(embedding_dim: usize) -> Result<Self, RecallError> {
        Self::with_config(
            embedding_dim,
            Bm25Params::default(),
            TokenizerConfig::default(),
        )
    }

    pub fn with_config(
        embedding_dim: usize,
        bm25_params: Bm25Params,
        tokenizer: TokenizerConfig,
    ) -> Result<Self, RecallError> {
        Ok(Self {
            next_chunk_id: 0,
            chunks: HashMap::new(),
            doc_chunks: HashMap::new(),
            bm25: Bm25Index::new(bm25_params, tokenizer),
            vectors: VectorStore::new(embedding_dim)?,
        })
    }

    pub fn stats(&self) -> IndexStats {
        IndexStats {
            document_count: self.doc_chunks.len(),
            chunk_count: self.chunks.len(),
            vector_count: self.vectors.len(),
            vocab_size: self.bm25.vocab_size(),
            embedding_dim: self.vectors.dim(),
        }
    }

    pub fn list_documents(&self) -> Vec<DocumentSummary> {
        let mut docs: Vec<DocumentSummary> = self
            .doc_chunks
            .iter()
            .filter_map(|(doc_id, ids)| {
                let first = ids.first().and_then(|id| self.chunks.get(id))?;
                Some(DocumentSummary {
                    doc_id: doc_id.clone(),
                    url: first.url.clone(),
                    title: first.title.clone(),
                    chunk_count: ids.len(),
                    saved_at_ms: first.saved_at_ms,
                })
            })
            .collect();
        docs.sort_by(|a, b| {
            b.saved_at_ms
                .cmp(&a.saved_at_ms)
                .then_with(|| a.doc_id.cmp(&b.doc_id))
        });
        docs
    }

    pub fn upsert_document(
        &mut self,
        doc_id: &str,
        url: &str,
        title: &str,
        saved_at_ms: u64,
        chunks: Vec<DraftChunk>,
        embeddings: Option<&[Vec<f32>]>,
    ) -> Result<usize, RecallError> {
        if let Some(vecs) = embeddings {
            if vecs.len() != chunks.len() {
                return Err(RecallError::InvalidConfig(format!(
                    "embedding count ({}) does not match chunk count ({})",
                    vecs.len(),
                    chunks.len()
                )));
            }
            for v in vecs {
                if v.len() != self.vectors.dim() {
                    return Err(RecallError::DimensionMismatch {
                        expected: self.vectors.dim(),
                        got: v.len(),
                    });
                }
            }
        }

        // Replace any previous snapshot of the same document or URL
        self.remove_document(doc_id);
        self.remove_by_url(url);

        let mut inserted_ids = Vec::with_capacity(chunks.len());

        for (i, draft) in chunks.into_iter().enumerate() {
            let chunk_id = self.next_chunk_id;
            self.next_chunk_id += 1;

            // Index heading + passage body together so section titles contribute to lexical recall
            let lexical_text = match &draft.heading {
                Some(h) if !h.is_empty() => format!("{h}\n{}", draft.text),
                _ => draft.text.clone(),
            };
            self.bm25.add_chunk(chunk_id, &lexical_text);

            if let Some(vecs) = embeddings {
                self.vectors.upsert(chunk_id, &vecs[i])?;
            }

            self.chunks.insert(
                chunk_id,
                StoredChunk {
                    id: chunk_id,
                    doc_id: doc_id.to_string(),
                    url: url.to_string(),
                    title: title.to_string(),
                    heading: draft.heading,
                    text: draft.text,
                    anchor_phrase: draft.anchor_phrase,
                    saved_at_ms,
                },
            );
            inserted_ids.push(chunk_id);
        }

        let count = inserted_ids.len();
        if count > 0 {
            self.doc_chunks.insert(doc_id.to_string(), inserted_ids);
        }
        Ok(count)
    }

    pub fn remove_document(&mut self, doc_id: &str) -> bool {
        let Some(chunk_ids) = self.doc_chunks.remove(doc_id) else {
            return false;
        };
        for id in chunk_ids {
            self.chunks.remove(&id);
            self.bm25.remove_chunk(id);
            self.vectors.remove(id);
        }
        true
    }

    pub fn remove_by_url(&mut self, url: &str) -> bool {
        let matching_docs: Vec<String> = self
            .doc_chunks
            .iter()
            .filter_map(|(doc_id, ids)| {
                let first = ids.first().and_then(|id| self.chunks.get(id))?;
                if first.url == url {
                    Some(doc_id.clone())
                } else {
                    None
                }
            })
            .collect();

        let mut removed = false;
        for doc_id in matching_docs {
            removed |= self.remove_document(&doc_id);
        }
        removed
    }

    pub fn search_keyword(&self, query: &str, top_k: usize) -> Vec<SearchResult> {
        self.bm25
            .search(query, top_k)
            .into_iter()
            .enumerate()
            .filter_map(|(idx, hit)| self.hydrate_single(hit, true, idx + 1))
            .collect()
    }

    pub fn search_semantic(
        &self,
        query_embedding: &[f32],
        top_k: usize,
    ) -> Result<Vec<SearchResult>, RecallError> {
        let hits = self.vectors.search(query_embedding, top_k)?;
        Ok(hits
            .into_iter()
            .enumerate()
            .filter_map(|(idx, hit)| self.hydrate_single(hit, false, idx + 1))
            .collect())
    }

    pub fn search_hybrid(
        &self,
        query: &str,
        query_embedding: &[f32],
        top_k: usize,
        rrf_k: Option<f32>,
    ) -> Result<Vec<SearchResult>, RecallError> {
        let pool = (top_k.saturating_mul(4)).max(50);
        let bm25_hits = self.bm25.search(query, pool);
        let mut vector_hits = self.vectors.search(query_embedding, pool)?;
        // Exclude orthogonal or negatively correlated vectors from positive RRF boosts
        vector_hits.retain(|hit| hit.score > 0.0);
        let fused = reciprocal_rank_fusion(
            &bm25_hits,
            &vector_hits,
            rrf_k.unwrap_or(DEFAULT_RRF_K),
            top_k,
        );
        Ok(fused
            .into_iter()
            .filter_map(|hit| self.hydrate_fused(hit))
            .collect())
    }

    pub fn to_json(&self) -> Result<String, RecallError> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn from_json(raw: &str) -> Result<Self, RecallError> {
        let mut index: Self = serde_json::from_str(raw)?;
        index.vectors.rebuild_lookup();
        Ok(index)
    }

    fn hydrate_single(&self, hit: RankedHit, is_bm25: bool, rank: usize) -> Option<SearchResult> {
        let chunk = self.chunks.get(&hit.chunk_id)?;
        Some(SearchResult {
            chunk_id: chunk.id,
            doc_id: chunk.doc_id.clone(),
            url: chunk.url.clone(),
            jump_url: build_text_fragment_url(&chunk.url, &chunk.anchor_phrase),
            title: chunk.title.clone(),
            heading: chunk.heading.clone(),
            text: chunk.text.clone(),
            anchor_phrase: chunk.anchor_phrase.clone(),
            score: hit.score,
            bm25_rank: is_bm25.then_some(rank),
            bm25_score: is_bm25.then_some(hit.score),
            vector_rank: (!is_bm25).then_some(rank),
            vector_score: (!is_bm25).then_some(hit.score),
        })
    }

    fn hydrate_fused(&self, hit: FusedHit) -> Option<SearchResult> {
        let chunk = self.chunks.get(&hit.chunk_id)?;
        Some(SearchResult {
            chunk_id: chunk.id,
            doc_id: chunk.doc_id.clone(),
            url: chunk.url.clone(),
            jump_url: build_text_fragment_url(&chunk.url, &chunk.anchor_phrase),
            title: chunk.title.clone(),
            heading: chunk.heading.clone(),
            text: chunk.text.clone(),
            anchor_phrase: chunk.anchor_phrase.clone(),
            score: hit.score,
            bm25_rank: hit.bm25_rank,
            bm25_score: hit.bm25_score,
            vector_rank: hit.vector_rank,
            vector_score: hit.vector_score,
        })
    }
}

/// Builds a Chrome Text Fragment link (`#:~:text=...`) stripped of any existing fragment.
pub fn build_text_fragment_url(base_url: &str, phrase: &str) -> String {
    let clean_base = base_url.split('#').next().unwrap_or(base_url);
    let trimmed = phrase.trim();
    if trimmed.is_empty() {
        return clean_base.to_string();
    }
    format!("{clean_base}#:~:text={}", percent_encode_fragment(trimmed))
}

fn percent_encode_fragment(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for byte in input.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~');
        // Note: '-' and ',' carry special meaning in Text Fragment directives, so percent-encode them
        if unreserved {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{chunk_document, ChunkingStrategy};

    #[test]
    fn hybrid_search_combines_keyword_and_semantic_signals() {
        let mut idx = RecallIndex::new(3).unwrap();

        let chunks_a = chunk_document(
            "# Background Tasks\n\nSend an email after returning an HTTP response.",
            &ChunkingStrategy::heading_default(),
        )
        .unwrap();
        let chunks_b = chunk_document(
            "# CORS\n\nConfigure Cross-Origin Resource Sharing middleware.",
            &ChunkingStrategy::heading_default(),
        )
        .unwrap();

        idx.upsert_document(
            "background-tasks",
            "https://fastapi.tiangolo.com/tutorial/background-tasks/",
            "Background Tasks",
            1_700_000_000_000,
            chunks_a,
            Some(&[vec![0.9, 0.1, 0.0]]),
        )
        .unwrap();

        idx.upsert_document(
            "cors",
            "https://fastapi.tiangolo.com/tutorial/cors/",
            "CORS",
            1_700_000_001_000,
            chunks_b,
            Some(&[vec![0.1, 0.9, 0.0]]),
        )
        .unwrap();

        let results = idx
            .search_hybrid("email after response", &[0.88, 0.12, 0.0], 2, None)
            .unwrap();
        assert_eq!(results[0].doc_id, "background-tasks");
        assert_eq!(results[0].bm25_rank, Some(1));
        assert_eq!(results[0].vector_rank, Some(1));
        assert!(results[0].jump_url.contains("#:~:text="));
    }

    #[test]
    fn resaving_same_url_replaces_old_chunks_cleanly() {
        let mut idx = RecallIndex::new(2).unwrap();
        let url = "https://fastapi.tiangolo.com/tutorial/cors/";

        let v1 =
            chunk_document("Old CORS policy text.", &ChunkingStrategy::fixed_default()).unwrap();
        idx.upsert_document("cors-v1", url, "CORS", 100, v1, Some(&[vec![1.0, 0.0]]))
            .unwrap();

        let v2 = chunk_document(
            "Updated allow_credentials guidance.",
            &ChunkingStrategy::fixed_default(),
        )
        .unwrap();
        idx.upsert_document("cors-v2", url, "CORS", 200, v2, Some(&[vec![0.0, 1.0]]))
            .unwrap();

        assert_eq!(idx.stats().document_count, 1);
        assert_eq!(idx.stats().chunk_count, 1);
        assert!(idx.search_keyword("old policy", 5).is_empty());
        assert_eq!(idx.search_keyword("allow_credentials", 5).len(), 1);
    }

    #[test]
    fn json_snapshot_roundtrip_restores_vector_lookup() {
        let mut idx = RecallIndex::new(2).unwrap();
        let chunks = chunk_document(
            "FastAPI testing uses TestClient built on httpx.",
            &ChunkingStrategy::fixed_default(),
        )
        .unwrap();
        idx.upsert_document(
            "testing",
            "https://fastapi.tiangolo.com/tutorial/testing/",
            "Testing",
            123,
            chunks,
            Some(&[vec![0.6, 0.8]]),
        )
        .unwrap();

        let json = idx.to_json().unwrap();
        let mut restored = RecallIndex::from_json(&json).unwrap();

        let hits = restored.search_semantic(&[0.6, 0.8], 3).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].doc_id, "testing");
        assert!(restored.remove_document("testing"));
        assert_eq!(restored.stats().vector_count, 0);
    }

    #[test]
    fn text_fragment_url_encodes_hyphens_and_strips_existing_hash() {
        let url = build_text_fragment_url(
            "https://fastapi.tiangolo.com/tutorial/cors/#using-corsmiddleware",
            "Cross-Origin Resource, Sharing",
        );
        assert_eq!(
            url,
            "https://fastapi.tiangolo.com/tutorial/cors/#:~:text=Cross%2DOrigin%20Resource%2C%20Sharing"
        );
    }
}
