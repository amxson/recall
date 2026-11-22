use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::tokenizer::{tokenize, TokenizerConfig};

pub type ChunkId = u32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Bm25Params {
    pub k1: f32,
    pub b: f32,
}

impl Default for Bm25Params {
    fn default() -> Self {
        Self { k1: 1.5, b: 0.75 }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct RankedHit {
    pub chunk_id: ChunkId,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bm25Index {
    params: Bm25Params,
    tokenizer: TokenizerConfig,
    postings: HashMap<String, Vec<(ChunkId, u32)>>,
    doc_lengths: HashMap<ChunkId, u32>,
    total_tokens: u64,
}

impl Default for Bm25Index {
    fn default() -> Self {
        Self::new(Bm25Params::default(), TokenizerConfig::default())
    }
}

impl Bm25Index {
    pub fn new(params: Bm25Params, tokenizer: TokenizerConfig) -> Self {
        Self {
            params,
            tokenizer,
            postings: HashMap::new(),
            doc_lengths: HashMap::new(),
            total_tokens: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.doc_lengths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.doc_lengths.is_empty()
    }

    pub fn vocab_size(&self) -> usize {
        self.postings.len()
    }

    pub fn avg_doc_len(&self) -> f32 {
        if self.doc_lengths.is_empty() {
            0.0
        } else {
            self.total_tokens as f32 / self.doc_lengths.len() as f32
        }
    }

    pub fn add_chunk(&mut self, chunk_id: ChunkId, text: &str) {
        if self.doc_lengths.contains_key(&chunk_id) {
            self.remove_chunk(chunk_id);
        }

        let tokens = tokenize(text, &self.tokenizer);
        let doc_len = tokens.len() as u32;

        let mut term_freqs: HashMap<String, u32> = HashMap::new();
        for token in tokens {
            *term_freqs.entry(token).or_insert(0) += 1;
        }

        for (term, tf) in term_freqs {
            self.postings.entry(term).or_default().push((chunk_id, tf));
        }

        self.doc_lengths.insert(chunk_id, doc_len);
        self.total_tokens += u64::from(doc_len);
    }

    pub fn remove_chunk(&mut self, chunk_id: ChunkId) -> bool {
        let Some(len) = self.doc_lengths.remove(&chunk_id) else {
            return false;
        };

        self.total_tokens = self.total_tokens.saturating_sub(u64::from(len));
        self.postings.retain(|_, list| {
            list.retain(|(id, _)| *id != chunk_id);
            !list.is_empty()
        });
        true
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<RankedHit> {
        if top_k == 0 || self.doc_lengths.is_empty() {
            return Vec::new();
        }

        let query_terms = tokenize(query, &self.tokenizer);
        if query_terms.is_empty() {
            return Vec::new();
        }

        let num_docs = self.doc_lengths.len() as f32;
        let avgdl = self.avg_doc_len().max(1.0);
        let k1 = self.params.k1;
        let b = self.params.b;

        let mut scores: HashMap<ChunkId, f32> = HashMap::new();

        for term in query_terms {
            let Some(posting_list) = self.postings.get(&term) else {
                continue;
            };

            let df = posting_list.len() as f32;
            // Lucene-style non-negative BM25 IDF
            let idf = ((num_docs - df + 0.5) / (df + 0.5) + 1.0).ln();

            for &(chunk_id, tf_u32) in posting_list {
                let tf = tf_u32 as f32;
                let dl = self.doc_lengths.get(&chunk_id).copied().unwrap_or(1) as f32;
                let denom = tf + k1 * (1.0 - b + b * (dl / avgdl));
                let term_score = idf * ((tf * (k1 + 1.0)) / denom);
                *scores.entry(chunk_id).or_insert(0.0) += term_score;
            }
        }

        let mut hits: Vec<RankedHit> = scores
            .into_iter()
            .map(|(chunk_id, score)| RankedHit { chunk_id, score })
            .collect();

        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.chunk_id.cmp(&b.chunk_id))
        });

        hits.truncate(top_k);
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_exact_and_rare_terms_higher() {
        let mut idx = Bm25Index::default();
        idx.add_chunk(0, "FastAPI lets you build APIs with Python type hints.");
        idx.add_chunk(
            1,
            "Use BackgroundTasks to send email notifications after returning a response.",
        );
        idx.add_chunk(
            2,
            "FastAPI uses Pydantic models for request body validation and response schemas.",
        );

        let hits = idx.search("background tasks email response", 3);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].chunk_id, 1);
    }

    #[test]
    fn handles_empty_index_and_unknown_terms() {
        let idx = Bm25Index::default();
        assert!(idx.search("fastapi", 5).is_empty());

        let mut idx = Bm25Index::default();
        idx.add_chunk(0, "Starlette middleware runs on every request.");
        assert!(idx.search("nonexistent_token_xyz", 5).is_empty());
        assert!(idx.search("middleware", 0).is_empty());
    }

    #[test]
    fn length_normalization_prefers_focused_passage() {
        let mut idx = Bm25Index::default();
        idx.add_chunk(
            0,
            "CORS allow_credentials cannot be combined with wildcard origin.",
        );
        idx.add_chunk(
            1,
            "CORS appears once inside a very long paragraph discussing routing, templates, \
             dependency injection, database sessions, migrations, testing clients, cookies, \
             headers, static files, and unrelated middleware setup details across many modules.",
        );

        let hits = idx.search("cors", 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].chunk_id, 0);
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn removing_chunk_cleans_postings_and_stats() {
        let mut idx = Bm25Index::default();
        idx.add_chunk(
            0,
            "jsonable_encoder converts models into JSON compatible dicts",
        );
        idx.add_chunk(
            1,
            "HTTPException returns custom status codes and detail messages",
        );

        assert_eq!(idx.len(), 2);
        assert!(idx.remove_chunk(0));
        assert!(!idx.remove_chunk(0));
        assert_eq!(idx.len(), 1);
        assert!(idx.search("jsonable_encoder", 5).is_empty());
        assert_eq!(idx.search("HTTPException", 5)[0].chunk_id, 1);
    }

    #[test]
    fn readding_same_chunk_id_replaces_old_content() {
        let mut idx = Bm25Index::default();
        idx.add_chunk(7, "old middleware content");
        idx.add_chunk(7, "fresh server sent events content");

        assert_eq!(idx.len(), 1);
        assert!(idx.search("middleware", 5).is_empty());
        assert_eq!(idx.search("server sent events", 5)[0].chunk_id, 7);
    }
}
