use recall_core::{chunk_document, ChunkingStrategy, DraftChunk, RecallIndex};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn chunk_text_json(text: &str, strategy: &str) -> Result<String, JsValue> {
    let parsed = parse_strategy(strategy)?;
    let chunks = chunk_document(text, &parsed).map_err(to_js_error)?;
    serde_json::to_string(&chunks).map_err(to_js_error)
}

#[wasm_bindgen]
pub struct WasmRecallIndex {
    inner: RecallIndex,
}

#[wasm_bindgen]
impl WasmRecallIndex {
    #[wasm_bindgen(constructor)]
    pub fn new(embedding_dim: usize) -> Result<WasmRecallIndex, JsValue> {
        let inner = RecallIndex::new(embedding_dim).map_err(to_js_error)?;
        Ok(Self { inner })
    }

    pub fn from_json(snapshot: &str) -> Result<WasmRecallIndex, JsValue> {
        let inner = RecallIndex::from_json(snapshot).map_err(to_js_error)?;
        Ok(Self { inner })
    }

    pub fn to_json(&self) -> Result<String, JsValue> {
        self.inner.to_json().map_err(to_js_error)
    }

    /// Upserts pre-chunked passages and an optional flat `Float32Array` of embeddings
    /// (`chunks.len() * embedding_dim`). Passing an empty array indexes BM25 only.
    pub fn upsert_document(
        &mut self,
        doc_id: &str,
        url: &str,
        title: &str,
        saved_at_ms: f64,
        chunks_json: &str,
        flat_embeddings: &[f32],
    ) -> Result<usize, JsValue> {
        let chunks: Vec<DraftChunk> = serde_json::from_str(chunks_json).map_err(to_js_error)?;
        let dim = self.inner.stats().embedding_dim;
        let saved_ms = if saved_at_ms.is_finite() && saved_at_ms >= 0.0 {
            saved_at_ms as u64
        } else {
            0
        };

        let unpacked: Option<Vec<Vec<f32>>> = if flat_embeddings.is_empty() {
            None
        } else {
            let expected_len = chunks.len().saturating_mul(dim);
            if flat_embeddings.len() != expected_len {
                return Err(JsValue::from_str(&format!(
                    "flat_embeddings length mismatch: expected {expected_len}, got {}",
                    flat_embeddings.len()
                )));
            }
            Some(
                flat_embeddings
                    .chunks_exact(dim)
                    .map(|slice| slice.to_vec())
                    .collect(),
            )
        };

        self.inner
            .upsert_document(doc_id, url, title, saved_ms, chunks, unpacked.as_deref())
            .map_err(to_js_error)
    }

    pub fn remove_document(&mut self, doc_id: &str) -> bool {
        self.inner.remove_document(doc_id)
    }

    pub fn remove_by_url(&mut self, url: &str) -> bool {
        self.inner.remove_by_url(url)
    }

    pub fn stats_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.stats()).map_err(to_js_error)
    }

    pub fn list_documents_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.list_documents()).map_err(to_js_error)
    }

    pub fn search_keyword_json(&self, query: &str, top_k: usize) -> Result<String, JsValue> {
        let hits = self.inner.search_keyword(query, top_k);
        serde_json::to_string(&hits).map_err(to_js_error)
    }

    pub fn search_semantic_json(
        &self,
        query_embedding: &[f32],
        top_k: usize,
    ) -> Result<String, JsValue> {
        let hits = self
            .inner
            .search_semantic(query_embedding, top_k)
            .map_err(to_js_error)?;
        serde_json::to_string(&hits).map_err(to_js_error)
    }

    pub fn search_hybrid_json(
        &self,
        query: &str,
        query_embedding: &[f32],
        top_k: usize,
        rrf_k: Option<f32>,
    ) -> Result<String, JsValue> {
        let hits = self
            .inner
            .search_hybrid(query, query_embedding, top_k, rrf_k)
            .map_err(to_js_error)?;
        serde_json::to_string(&hits).map_err(to_js_error)
    }
}

fn parse_strategy(name: &str) -> Result<ChunkingStrategy, JsValue> {
    match name {
        "fixed" => Ok(ChunkingStrategy::fixed_default()),
        "heading" => Ok(ChunkingStrategy::heading_default()),
        "sentence" => Ok(ChunkingStrategy::sentence_default()),
        other => Err(JsValue::from_str(&format!(
            "unknown chunking strategy '{other}' (expected fixed, heading, or sentence)"
        ))),
    }
}

fn to_js_error(err: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&err.to_string())
}
