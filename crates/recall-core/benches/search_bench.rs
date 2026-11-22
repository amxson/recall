use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use recall_core::{DraftChunk, RecallIndex};

const DIM: usize = 384;

fn synthetic_vector(seed: usize) -> Vec<f32> {
    let mut state = (seed as u64)
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1);
    let mut vec = Vec::with_capacity(DIM);
    for _ in 0..DIM {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let bits = ((state >> 33) as u32) as f32 / (u32::MAX as f32);
        vec.push(bits * 2.0 - 1.0);
    }
    vec
}

fn build_index(passage_count: usize) -> RecallIndex {
    let templates = [
        "FastAPI BackgroundTasks schedules email notifications after returning an HTTP response to the client.",
        "CORSMiddleware controls allowed origins, credentials, methods, and custom headers on cross-origin requests.",
        "HTTPException raises structured error payloads with custom status codes and optional response headers.",
        "Response models filter sensitive fields like hashed passwords before serializing Pydantic objects to JSON.",
        "SQLModel sessions inject database connections per request using yield dependencies for clean teardown.",
        "TestClient wraps httpx to test path operations, cookies, file uploads, and status codes synchronously.",
    ];

    let mut index = RecallIndex::new(DIM).expect("index init");
    let mut chunks = Vec::with_capacity(passage_count);
    let mut embeddings = Vec::with_capacity(passage_count);

    for i in 0..passage_count {
        let base = templates[i % templates.len()];
        chunks.push(DraftChunk {
            chunk_index: i,
            heading: Some(format!("Section {}", i % 20)),
            text: format!(
                "{base} Passage variant {i} covering middleware, validation, and async routing."
            ),
            anchor_phrase: "FastAPI BackgroundTasks schedules email".into(),
        });
        embeddings.push(synthetic_vector(i + 1));
    }

    index
        .upsert_document(
            "bench-corpus",
            "https://fastapi.tiangolo.com/tutorial/",
            "Benchmark Corpus",
            0,
            chunks,
            Some(&embeddings),
        )
        .expect("upsert");

    index
}

fn bench_search(c: &mut Criterion) {
    let query_text = "BackgroundTasks email notification after HTTP response";
    let query_vec = synthetic_vector(999_999);

    let mut group = c.benchmark_group("search_latency");
    for &size in &[500usize, 2_000, 5_000] {
        let index = build_index(size);

        group.bench_with_input(BenchmarkId::new("bm25", size), &size, |b, _| {
            b.iter(|| index.search_keyword(black_box(query_text), 10));
        });

        group.bench_with_input(BenchmarkId::new("cosine_384d", size), &size, |b, _| {
            b.iter(|| index.search_semantic(black_box(&query_vec), 10).unwrap());
        });

        group.bench_with_input(BenchmarkId::new("hybrid_rrf", size), &size, |b, _| {
            b.iter(|| {
                index
                    .search_hybrid(black_box(query_text), black_box(&query_vec), 10, None)
                    .unwrap()
            });
        });
    }
    group.finish();
}

criterion_group!(benches, bench_search);
criterion_main!(benches);
