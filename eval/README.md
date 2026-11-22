# Recall Evaluation Protocol

This directory holds the frozen corpus definition, hand-written evaluation queries, and benchmark scripts used to measure keyword (BM25), semantic (vector cosine), and hybrid (RRF) retrieval across chunking strategies.

## Frozen Corpus

- **Source:** `fastapi/fastapi` (`docs/en/docs/tutorial/*.md`)
- **Pinned release:** `v0.165.0` (`05e6df7e906c3decba377c37548019973f40bf15`)
- **Size:** 40 tutorial documentation pages

Reproduce the local corpus snapshot at any time:

```bash
python eval/fetch_corpus.py
```

The script strips MkDocs include directives and admonition fences, saves cleaned Markdown under `eval/corpus/`, and verifies/writes SHA-256 digests in `eval/corpus_manifest.json`.

## Query Authoring Rules

All evaluation queries in `eval/queries.jsonl` must be authored **before** tuning tokenizer settings, chunking parameters, or fusion weights:

1. Aim for 40–60 realistic "search from memory" queries across 4 categories:
   - `exact`: specific class/parameter/header names (`HTTPException`, `BackgroundTasks`, `jsonable_encoder`)
   - `conceptual`: paraphrased questions without exact API keywords (*"run cleanup work after returning the response"*)
   - `mixed`: partial API term + behavioral memory (*"CORS allow credentials wildcard issue"*)
   - `hard`: subtle edge cases or topics split across multiple pages
2. Each query specifies `expected_docs` (one or more `doc_id` values from `corpus_manifest.json`) and optional `expected_heading` / `evidence_phrase` to verify passage-level recall.
3. Never delete queries that perform poorly—document misses in the failure analysis.
