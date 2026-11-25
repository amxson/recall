/**
 * Reproducible retrieval evaluation harness for Recall.
 *
 * Evaluates BM25, brute-force cosine vector search, and Hybrid RRF (k=60)
 * across three chunking strategies (fixed, heading, sentence) on the frozen
 * 40-doc FastAPI v0.165.0 corpus and 50 hand-written queries in eval/queries.jsonl.
 *
 * Usage:
 *   node eval/run_benchmark.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extDir = resolve(repoRoot, "extension");

const { env, pipeline } = await import(
  pathToFileURL(resolve(extDir, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs")).href
);
const { initSync, WasmRecallIndex, chunk_text_json } = await import(
  pathToFileURL(resolve(extDir, "src", "wasm", "recall_wasm.js")).href
);

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const STRATEGIES = ["fixed", "heading", "sentence"];
const METHODS = ["bm25", "vector", "hybrid"];
const RRF_K = 60;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function dedupeRankedDocs(hits) {
  const seen = new Set();
  const docs = [];
  for (const hit of hits) {
    if (!seen.has(hit.doc_id)) {
      seen.add(hit.doc_id);
      docs.push(hit.doc_id);
    }
  }
  return docs;
}

function computeNdcgAtK(rankedDocs, expectedSet, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedDocs.length); i++) {
    if (expectedSet.has(rankedDocs[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  const idealCount = Math.min(k, expectedSet.size);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

function round(n, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

async function main() {
  const wasmBytes = readFileSync(resolve(extDir, "src", "wasm", "recall_wasm_bg.wasm"));
  initSync({ module: wasmBytes });

  const manifest = JSON.parse(readFileSync(resolve(__dirname, "corpus_manifest.json"), "utf8"));
  const queries = readFileSync(resolve(__dirname, "queries.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  const docs = manifest.documents.map((d) => ({
    ...d,
    markdown: readFileSync(resolve(__dirname, "corpus", d.filename), "utf8"),
  }));

  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useFSCache = true;
  env.cacheDir = resolve(__dirname, "cache", "hf-models");

  console.log(`Loading ${MODEL_ID} (q8)...`);
  const extractor = await pipeline("feature-extraction", MODEL_ID, {
    dtype: "q8",
    device: "cpu",
  });

  console.log(`Embedding ${queries.length} evaluation queries...`);
  const queryVectors = [];
  for (const q of queries) {
    const out = await extractor(q.query, { pooling: "mean", normalize: true });
    queryVectors.push(new Float32Array(out.data));
  }

  // Export query vectors for preset demo queries
  const cacheDir = resolve(__dirname, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const resultsDir = resolve(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });

  const runs = [];

  for (const strategy of STRATEGIES) {
    console.log(`\n=== Strategy: ${strategy} ===`);
    const index = new WasmRecallIndex(384);
    const tIndexStart = performance.now();
    let totalChunks = 0;

    for (let dIdx = 0; dIdx < docs.length; dIdx++) {
      const doc = docs[dIdx];
      const chunksJson = chunk_text_json(doc.markdown, strategy);
      const chunks = JSON.parse(chunksJson);
      const texts = chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text));
      const flat = new Float32Array(chunks.length * 384);

      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16);
        const out = await extractor(batch, { pooling: "mean", normalize: true });
        flat.set(out.data, i * 384);
      }

      index.upsert_document(doc.doc_id, doc.url, doc.title, 0, chunksJson, flat);
      totalChunks += chunks.length;
    }

    const indexBuildMs = performance.now() - tIndexStart;
    const stats = JSON.parse(index.stats_json());
    console.log(
      `Indexed ${stats.document_count} docs -> ${totalChunks} chunks in ${(indexBuildMs / 1000).toFixed(1)}s`
    );

    if (strategy === "heading") {
      // Save pre-indexed heading snapshot + sample preset query vectors for the public web demo
      const snapshotJson = index.to_json();
      writeFileSync(resolve(cacheDir, "fastapi-heading-snapshot.json"), snapshotJson, "utf8");

      const presetIds = ["q01", "q02", "q07", "q14", "q15", "q16", "q19", "q24", "q34", "q41", "q44", "q46"];
      const presetMap = {};
      queries.forEach((q, idx) => {
        if (presetIds.includes(q.id)) {
          presetMap[q.id] = {
            id: q.id,
            category: q.category,
            query: q.query,
            expected_docs: q.expected_docs,
            embedding: Array.from(queryVectors[idx], (v) => Number(v.toFixed(5))),
          };
        }
      });
      writeFileSync(
        resolve(cacheDir, "demo-presets.json"),
        JSON.stringify(Object.values(presetMap), null, 2) + "\n",
        "utf8"
      );
      console.log(
        `Exported demo snapshot (${(Buffer.byteLength(snapshotJson) / (1024 * 1024)).toFixed(2)} MB) + ${Object.keys(presetMap).length} presets`
      );
    }

    for (const method of METHODS) {
      // Warmup 5 queries
      for (let w = 0; w < 5; w++) {
        if (method === "bm25") index.search_keyword_json(queries[w].query, 20);
        else if (method === "vector") index.search_semantic_json(queryVectors[w], 20);
        else index.search_hybrid_json(queries[w].query, queryVectors[w], 20, RRF_K);
      }

      const latencies = [];
      const perQuery = [];

      // Measure 3 passes for stable p50/p95 timings; collect accuracy on pass 0
      for (let pass = 0; pass < 3; pass++) {
        for (let qi = 0; qi < queries.length; qi++) {
          const q = queries[qi];
          const t0 = performance.now();
          let raw;
          if (method === "bm25") {
            raw = index.search_keyword_json(q.query, 25);
          } else if (method === "vector") {
            raw = index.search_semantic_json(queryVectors[qi], 25);
          } else {
            raw = index.search_hybrid_json(q.query, queryVectors[qi], 25, RRF_K);
          }
          const elapsed = performance.now() - t0;
          latencies.push(elapsed);

          if (pass === 0) {
            const hits = JSON.parse(raw);
            const rankedDocs = dedupeRankedDocs(hits);
            const expectedSet = new Set(q.expected_docs);

            const firstIdx = rankedDocs.findIndex((d) => expectedSet.has(d));
            const firstRank = firstIdx === -1 ? null : firstIdx + 1;
            const recallAt1 = firstRank !== null && firstRank <= 1 ? 1 : 0;
            const recallAt5 = firstRank !== null && firstRank <= 5 ? 1 : 0;
            const mrrAt10 = firstRank !== null && firstRank <= 10 ? 1 / firstRank : 0;
            const ndcgAt10 = computeNdcgAtK(rankedDocs, expectedSet, 10);

            perQuery.push({
              id: q.id,
              category: q.category,
              query: q.query,
              expected_docs: q.expected_docs,
              top3_docs: rankedDocs.slice(0, 3),
              first_rank: firstRank,
              hit_at_1: recallAt1 === 1,
              hit_at_5: recallAt5 === 1,
              mrr_at_10: round(mrrAt10, 4),
              ndcg_at_10: round(ndcgAt10, 4),
            });
          }
        }
      }

      const avg = (fn) => perQuery.reduce((acc, r) => acc + fn(r), 0) / perQuery.length;
      const categories = ["exact", "conceptual", "mixed", "hard"];
      const byCategory = {};
      for (const cat of categories) {
        const subset = perQuery.filter((r) => r.category === cat);
        byCategory[cat] = {
          count: subset.length,
          recall_at_1: round(subset.reduce((a, r) => a + (r.hit_at_1 ? 1 : 0), 0) / subset.length),
          recall_at_5: round(subset.reduce((a, r) => a + (r.hit_at_5 ? 1 : 0), 0) / subset.length),
          mrr_at_10: round(subset.reduce((a, r) => a + r.mrr_at_10, 0) / subset.length),
          ndcg_at_10: round(subset.reduce((a, r) => a + r.ndcg_at_10, 0) / subset.length),
        };
      }

      const summary = {
        method,
        strategy,
        chunks: totalChunks,
        recall_at_1: round(avg((r) => (r.hit_at_1 ? 1 : 0))),
        recall_at_5: round(avg((r) => (r.hit_at_5 ? 1 : 0))),
        mrr_at_10: round(avg((r) => r.mrr_at_10)),
        ndcg_at_10: round(avg((r) => r.ndcg_at_10)),
        p50_ms: round(percentile(latencies, 50), 3),
        p95_ms: round(percentile(latencies, 95), 3),
        by_category: byCategory,
        misses_at_5: perQuery.filter((r) => !r.hit_at_5),
        per_query: perQuery,
      };

      runs.push(summary);
      console.log(
        `  ${method.padEnd(6)} | R@1=${(summary.recall_at_1 * 100).toFixed(1)}% R@5=${(summary.recall_at_5 * 100).toFixed(1)}% MRR@10=${summary.mrr_at_10.toFixed(3)} NDCG@10=${summary.ndcg_at_10.toFixed(3)} | p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms | misses@5=${summary.misses_at_5.length}`
      );
    }

    index.free();
  }

  // Head-to-head comparison on heading-aware chunking
  const headingBm25 = runs.find((r) => r.strategy === "heading" && r.method === "bm25");
  const headingVec = runs.find((r) => r.strategy === "heading" && r.method === "vector");
  const headingHybrid = runs.find((r) => r.strategy === "heading" && r.method === "hybrid");

  const headToHead = {
    strategy: "heading",
    hybrid_beats_bm25_mrr: 0,
    bm25_beats_hybrid_mrr: 0,
    hybrid_ties_bm25_mrr: 0,
    hybrid_beats_vector_mrr: 0,
    vector_beats_hybrid_mrr: 0,
    hybrid_ties_vector_mrr: 0,
    bm25_wins_examples: [],
    vector_wins_examples: [],
    both_miss_examples: [],
  };

  for (let i = 0; i < queries.length; i++) {
    const b = headingBm25.per_query[i];
    const v = headingVec.per_query[i];
    const h = headingHybrid.per_query[i];

    if (h.mrr_at_10 > b.mrr_at_10) headToHead.hybrid_beats_bm25_mrr++;
    else if (b.mrr_at_10 > h.mrr_at_10) headToHead.bm25_beats_hybrid_mrr++;
    else headToHead.hybrid_ties_bm25_mrr++;

    if (h.mrr_at_10 > v.mrr_at_10) headToHead.hybrid_beats_vector_mrr++;
    else if (v.mrr_at_10 > h.mrr_at_10) headToHead.vector_beats_hybrid_mrr++;
    else headToHead.hybrid_ties_vector_mrr++;

    if (b.mrr_at_10 > v.mrr_at_10 + 0.15) {
      headToHead.bm25_wins_examples.push({
        id: b.id,
        category: b.category,
        query: b.query,
        expected: b.expected_docs,
        bm25_rank: b.first_rank,
        vector_rank: v.first_rank,
        hybrid_rank: h.first_rank,
        vector_top1: v.top3_docs[0] ?? null,
      });
    }
    if (v.mrr_at_10 > b.mrr_at_10 + 0.15) {
      headToHead.vector_wins_examples.push({
        id: b.id,
        category: b.category,
        query: b.query,
        expected: b.expected_docs,
        bm25_rank: b.first_rank,
        vector_rank: v.first_rank,
        hybrid_rank: h.first_rank,
        bm25_top1: b.top3_docs[0] ?? null,
      });
    }
    if (!h.hit_at_5) {
      headToHead.both_miss_examples.push({
        id: h.id,
        category: h.category,
        query: h.query,
        expected: h.expected_docs,
        bm25_rank: b.first_rank,
        vector_rank: v.first_rank,
        hybrid_rank: h.first_rank,
        hybrid_top3: h.top3_docs,
      });
    }
  }

  const output = {
    generated_at: new Date().toISOString(),
    corpus: {
      source_repo: manifest.source_repo,
      tag: manifest.tag,
      commit_sha: manifest.commit_sha,
      documents: manifest.document_count,
      total_words: manifest.total_words,
    },
    queries: {
      count: queries.length,
      categories: {
        exact: queries.filter((q) => q.category === "exact").length,
        conceptual: queries.filter((q) => q.category === "conceptual").length,
        mixed: queries.filter((q) => q.category === "mixed").length,
        hard: queries.filter((q) => q.category === "hard").length,
      },
    },
    environment: {
      model: MODEL_ID,
      dtype: "q8",
      rrf_k: RRF_K,
      node: process.version,
      platform: `${platform()}-${arch()}`,
      cpu: cpus()[0]?.model ?? "unknown",
    },
    summary_table: runs.map(({ per_query, misses_at_5, ...rest }) => ({
      ...rest,
      misses_at_5_count: misses_at_5.length,
    })),
    head_to_head_heading: headToHead,
    runs,
  };

  const outPath = resolve(resultsDir, "benchmark_results.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote benchmark results -> ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
