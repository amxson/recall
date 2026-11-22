use recall_core::{chunk_document, ChunkingStrategy, RecallIndex, DEFAULT_RRF_K};

const SAMPLE_BACKGROUND_TASKS: &str = "\
# Background Tasks

You can define background tasks to be run after returning a response.
This is useful for operations like sending email notifications or processing uploaded files
without blocking the client request.

## Using BackgroundTasks

Import BackgroundTasks and declare a parameter in your path operation function.
Call background_tasks.add_task with the function and its positional or keyword arguments.

## Dependency Injection

BackgroundTasks works across dependencies and sub-dependencies. FastAPI merges tasks
added at every dependency level and runs them in order after sending the response.
";

const SAMPLE_CORS: &str = "\
# CORS (Cross-Origin Resource Sharing)

Browsers enforce same-origin restrictions when a frontend runs on a different port or domain
than your FastAPI backend.

## Wildcards

If allow_credentials is set to True, allow_origins cannot be set to ['*'].
Specify explicit origins when sending cookies or Authorization headers across origins.

## Use CORSMiddleware

Import CORSMiddleware from fastapi.middleware.cors and attach it with app.add_middleware.
";

const SAMPLE_ERRORS: &str = "\
# Handling Errors

Raise HTTPException when a client asks for a missing item or lacks permission.

## Custom Exception Handlers

Register a custom handler with @app.exception_handler to override default JSON responses
or add custom headers to error payloads.
";

fn unit_vec(weights: [f32; 4]) -> Vec<f32> {
    let norm = weights.iter().map(|x| x * x).sum::<f32>().sqrt();
    weights.iter().map(|x| x / norm).collect()
}

#[test]
fn end_to_end_chunk_index_search_and_snapshot_roundtrip() {
    let mut index = RecallIndex::new(4).expect("index init");

    let bg_chunks = chunk_document(
        SAMPLE_BACKGROUND_TASKS,
        &ChunkingStrategy::heading_default(),
    )
    .unwrap();
    let bg_vecs: Vec<Vec<f32>> = bg_chunks
        .iter()
        .map(|_| unit_vec([1.0, 0.0, 0.0, 0.0]))
        .collect();

    let cors_chunks = chunk_document(SAMPLE_CORS, &ChunkingStrategy::heading_default()).unwrap();
    let cors_vecs: Vec<Vec<f32>> = cors_chunks
        .iter()
        .map(|_| unit_vec([0.0, 1.0, 0.0, 0.0]))
        .collect();

    let err_chunks = chunk_document(SAMPLE_ERRORS, &ChunkingStrategy::heading_default()).unwrap();
    let err_vecs: Vec<Vec<f32>> = err_chunks
        .iter()
        .map(|_| unit_vec([0.0, 0.0, 1.0, 0.0]))
        .collect();

    index
        .upsert_document(
            "background-tasks",
            "https://fastapi.tiangolo.com/tutorial/background-tasks/",
            "Background Tasks",
            1_700_000_000_000,
            bg_chunks,
            Some(&bg_vecs),
        )
        .unwrap();
    index
        .upsert_document(
            "cors",
            "https://fastapi.tiangolo.com/tutorial/cors/",
            "CORS",
            1_700_000_001_000,
            cors_chunks,
            Some(&cors_vecs),
        )
        .unwrap();
    index
        .upsert_document(
            "handling-errors",
            "https://fastapi.tiangolo.com/tutorial/handling-errors/",
            "Handling Errors",
            1_700_000_002_000,
            err_chunks,
            Some(&err_vecs),
        )
        .unwrap();

    assert_eq!(index.stats().document_count, 3);
    assert!(index.stats().chunk_count >= 7);
    assert_eq!(index.stats().chunk_count, index.stats().vector_count);

    // Pure conceptual query with zero lexical overlap still succeeds via hybrid RRF
    let conceptual_hits = index
        .search_hybrid(
            "dispatch async work once reply finishes",
            &unit_vec([0.95, 0.0, 0.0, 0.0]),
            3,
            Some(DEFAULT_RRF_K),
        )
        .unwrap();
    assert_eq!(conceptual_hits[0].doc_id, "background-tasks");
    assert!(conceptual_hits[0].vector_rank.is_some());

    // Orthogonal vector should not receive a positive RRF vector rank boost
    let stray_token_hits = index
        .search_hybrid(
            "dispatch async work once http reply finishes",
            &unit_vec([1.0, 0.0, 0.0, 0.0]),
            5,
            Some(DEFAULT_RRF_K),
        )
        .unwrap();
    let err_hit = stray_token_hits
        .iter()
        .find(|h| h.doc_id == "handling-errors")
        .expect("handling-errors should match on lexical 'http'");
    assert!(err_hit.vector_rank.is_none());

    // Exact identifier query succeeds via BM25 even with neutral embedding
    let lexical_hits = index.search_keyword("allow_credentials allow_origins wildcard", 3);
    assert_eq!(lexical_hits[0].doc_id, "cors");
    assert_eq!(lexical_hits[0].heading.as_deref(), Some("Wildcards"));

    // Snapshot roundtrip preserves both lexical and vector search plus document listing order
    let snapshot = index.to_json().unwrap();
    let restored = RecallIndex::from_json(&snapshot).unwrap();
    let docs = restored.list_documents();
    assert_eq!(docs.len(), 3);
    assert_eq!(docs[0].doc_id, "handling-errors");

    let restored_hits = restored
        .search_hybrid(
            "custom headers error payloads",
            &unit_vec([0.05, 0.05, 0.95, 0.0]),
            3,
            None,
        )
        .unwrap();
    assert_eq!(restored_hits[0].doc_id, "handling-errors");
    assert!(restored_hits[0]
        .jump_url
        .starts_with("https://fastapi.tiangolo.com/tutorial/handling-errors/#:~:text="));
}

#[test]
fn chunking_strategies_produce_distinct_granularity_on_same_doc() {
    let fixed = chunk_document(
        SAMPLE_BACKGROUND_TASKS,
        &ChunkingStrategy::FixedSize {
            max_words: 35,
            overlap_words: 5,
        },
    )
    .unwrap();
    let heading = chunk_document(
        SAMPLE_BACKGROUND_TASKS,
        &ChunkingStrategy::heading_default(),
    )
    .unwrap();
    let sentence = chunk_document(
        SAMPLE_BACKGROUND_TASKS,
        &ChunkingStrategy::SentenceWindow {
            sentences_per_chunk: 2,
            overlap_sentences: 1,
        },
    )
    .unwrap();

    assert!(fixed.len() >= 2);
    assert_eq!(heading.len(), 3);
    assert!(sentence.len() >= 4);
    assert!(heading.iter().all(|c| c.heading.is_some()));
}
