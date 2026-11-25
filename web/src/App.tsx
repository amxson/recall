import { useEffect, useMemo, useRef, useState } from "react";

import { loadDemoEngine, runDemoSearch, type DemoEngineHandle } from "./engine";
import type { SearchHit, SearchMode } from "./types";

type ActiveTab = "playground" | "benchmarks";

const REPO_URL = "https://github.com/amxson/recall";

export default function App() {
  const [tab, setTab] = useState<ActiveTab>(() =>
    window.location.hash === "#benchmarks" ? "benchmarks" : "playground"
  );
  const [handle, setHandle] = useState<DemoEngineHandle | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [latency, setLatency] = useState<{
    embedMs: number;
    searchMs: number;
    usedPresetVector: boolean;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const searchSeq = useRef(0);

  useEffect(() => {
    let active = true;
    loadDemoEngine()
      .then((loaded) => {
        if (!active) {
          loaded.index.free();
          return;
        }
        setHandle(loaded);
        // Pre-run a crisp conceptual memory query so visitors immediately see hybrid retrieval
        const initial =
          loaded.presets.find((p) => p.id === "q14") ?? loaded.presets[0];
        if (initial) {
          setQuery(initial.query);
        }
      })
      .catch((err) => {
        if (active) {
          setBootError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!handle) return;
    if (!query.trim()) {
      setHits([]);
      setLatency(null);
      return;
    }

    const seq = ++searchSeq.current;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const res = await runDemoSearch(handle, query, mode, 8, (pct) => {
          setModelProgress(pct < 100 ? pct : null);
        });
        if (seq !== searchSeq.current) return;
        setHits(res.hits);
        setLatency({
          embedMs: res.embedMs,
          searchMs: res.searchMs,
          usedPresetVector: res.usedPresetVector,
        });
        setModelProgress(null);
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setSearchError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === searchSeq.current) {
          setSearching(false);
        }
      }
    }, 120);

    return () => window.clearTimeout(timer);
  }, [handle, query, mode]);

  const activePreset = useMemo(
    () =>
      handle?.presets.find(
        (p) => p.query.trim().toLowerCase() === query.trim().toLowerCase()
      ) ?? null,
    [handle, query]
  );

  const switchTab = (next: ActiveTab) => {
    setTab(next);
    window.history.replaceState(null, "", next === "benchmarks" ? "#benchmarks" : "#search");
  };

  return (
    <div className="page">
      <header className="header">
        <div className="header-inner">
          <div className="brand-block">
            <div className="brand-row">
              <span className="dot" aria-hidden="true" />
              <span className="brand-name">Recall</span>
              <span className="version-tag">Rust → WASM · v0.1</span>
            </div>
            <p className="brand-sub">
              Local-first hybrid search (BM25 + L2 cosine + RRF k=60) running completely in your browser.
            </p>
          </div>

          <div className="header-links">
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="link-btn">
              GitHub ↗
            </a>
            <a
              href={`${REPO_URL}/blob/main/extension/README.md`}
              target="_blank"
              rel="noreferrer"
              className="link-btn primary"
            >
              Chrome Extension ↗
            </a>
          </div>
        </div>

        <div className="nav-tabs">
          <button
            type="button"
            className={tab === "playground" ? "nav-tab active" : "nav-tab"}
            onClick={() => switchTab("playground")}
          >
            Live WASM Search
          </button>
          <button
            type="button"
            className={tab === "benchmarks" ? "nav-tab active" : "nav-tab"}
            onClick={() => switchTab("benchmarks")}
          >
            Benchmarks &amp; Failure Analysis
          </button>
          {handle && (
            <div className="corpus-meta">
              <span>{handle.stats.document_count} FastAPI docs</span>
              <span>·</span>
              <span>{handle.stats.chunk_count} passages</span>
              <span>·</span>
              <span>{handle.stats.embedding_dim}d MiniLM q8</span>
              <span>·</span>
              <span>loaded in {Math.round(handle.loadMs)} ms</span>
            </div>
          )}
        </div>
      </header>

      <main className="main">
        {bootError && (
          <div className="banner error">Failed to initialize WASM engine: {bootError}</div>
        )}

        {!handle && !bootError && (
          <div className="banner">Initializing Rust WebAssembly index and 40-doc FastAPI snapshot…</div>
        )}

        {handle && tab === "playground" && (
          <section className="playground">
            <div className="search-card">
              <div className="input-row">
                <input
                  type="search"
                  className="search-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search FastAPI docs from memory (e.g. run cleanup work after returning response)…"
                  aria-label="Search FastAPI documentation"
                />
                <div className="mode-switch" role="group" aria-label="Retrieval mode">
                  {(["hybrid", "keyword", "semantic"] as SearchMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={mode === m ? "mode-pill active" : "mode-pill"}
                      onClick={() => setMode(m)}
                    >
                      {m === "hybrid" ? "Hybrid (RRF)" : m === "keyword" ? "BM25" : "Vector"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="preset-strip">
                <span className="preset-label">Try a memory query:</span>
                <div className="preset-chips">
                  {handle.presets.slice(0, 8).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={activePreset?.id === p.id ? "chip active" : "chip"}
                      onClick={() => setQuery(p.query)}
                      title={`Category: ${p.category} | Expected: ${p.expected_docs.join(", ")}`}
                    >
                      <span className={`cat cat-${p.category}`}>{p.category}</span>
                      <span>{truncate(p.query, 44)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="telemetry-bar">
                <div>
                  {modelProgress !== null && (
                    <span className="em">
                      Downloading in-browser MiniLM q8 model for custom query… {modelProgress}%
                    </span>
                  )}
                  {modelProgress === null && searching && <span>Running search…</span>}
                  {modelProgress === null && !searching && latency && (
                    <span>
                      <strong>{hits.length}</strong> passages in{" "}
                      <strong className="em">
                        {latency.searchMs < 0.1 ? "<0.1 ms" : `${latency.searchMs.toFixed(2)} ms`}
                      </strong>{" "}
                      (Rust/WASM)
                      {mode !== "keyword" && (
                        <>
                          {" · "}
                          {latency.usedPresetVector
                            ? "pre-embedded preset vector"
                            : `live browser embed ${latency.embedMs.toFixed(0)} ms`}
                        </>
                      )}
                    </span>
                  )}
                </div>
                {activePreset && (
                  <div className="expected-note">
                    Expected doc: <code>{activePreset.expected_docs.join(", ")}</code>
                  </div>
                )}
              </div>

              {searchError && <div className="banner error">{searchError}</div>}
            </div>

            <div className="results-grid">
              {hits.map((hit, idx) => {
                const isExpected = activePreset?.expected_docs.includes(hit.doc_id) ?? false;
                return (
                  <a
                    key={hit.chunk_id}
                    href={hit.jump_url}
                    target="_blank"
                    rel="noreferrer"
                    className={isExpected ? "result-card matched" : "result-card"}
                  >
                    <div className="result-head">
                      <div className="result-title-group">
                        <span className="rank-num">#{idx + 1}</span>
                        <h3>{hit.title}</h3>
                        {hit.heading && hit.heading !== hit.title && (
                          <span className="heading-crumb">› {hit.heading}</span>
                        )}
                      </div>
                      <div className="score-pills">
                        {hit.bm25_rank !== null && (
                          <span className="pill">BM25 #{hit.bm25_rank}</span>
                        )}
                        {hit.vector_rank !== null && (
                          <span className="pill em">Vec #{hit.vector_rank}</span>
                        )}
                        <span className="pill score">
                          {mode === "hybrid"
                            ? `RRF ${hit.score.toFixed(4)}`
                            : hit.score.toFixed(3)}
                        </span>
                      </div>
                    </div>

                    <p className="result-text">{truncate(cleanPreview(hit.text), 300)}</p>

                    <div className="result-foot">
                      <span className="jump-url">{hit.url}</span>
                      <span className="jump-cta">Jump to highlighted passage ↗</span>
                    </div>
                  </a>
                );
              })}
            </div>
          </section>
        )}

        {handle && tab === "benchmarks" && (
          <section className="benchmarks">
            <div className="bench-intro">
              <h2>Reproducible Evaluation &amp; Failure Analysis</h2>
              <p>
                Evaluated on{" "}
                <strong>
                  {handle.benchmarks.corpus.documents} frozen FastAPI{" "}
                  {handle.benchmarks.corpus.tag} docs
                </strong>{" "}
                ({handle.benchmarks.corpus.total_words.toLocaleString()} words) using{" "}
                <strong>{handle.benchmarks.queries.count} queries</strong> authored before running
                any ranking code ({handle.benchmarks.environment.model},{" "}
                {handle.benchmarks.environment.dtype}, RRF k={handle.benchmarks.environment.rrf_k}).
              </p>
            </div>

            <div className="card-block">
              <div className="block-head">
                <h3>All 9 Configurations (Method × Chunker)</h3>
                <span className="mono-note">
                  Host: {handle.benchmarks.environment.cpu} · {handle.benchmarks.environment.node}
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Chunker</th>
                      <th className="num">Chunks</th>
                      <th className="num">R@1</th>
                      <th className="num">R@5</th>
                      <th className="num">MRR@10</th>
                      <th className="num">NDCG@10</th>
                      <th className="num">WASM p50</th>
                      <th className="num">WASM p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {handle.benchmarks.summary_table.map((row) => {
                      const isBest = row.strategy === "fixed" && row.method === "hybrid";
                      return (
                        <tr
                          key={`${row.strategy}-${row.method}`}
                          className={isBest ? "highlight-row" : ""}
                        >
                          <td className="mono">{row.method}</td>
                          <td>{row.strategy}</td>
                          <td className="num mono">{row.chunks}</td>
                          <td className="num mono">{(row.recall_at_1 * 100).toFixed(1)}%</td>
                          <td className="num mono">{(row.recall_at_5 * 100).toFixed(1)}%</td>
                          <td className="num mono">
                            <div className="bar-cell">
                              <span className="bar-track">
                                <span
                                  className="bar-fill"
                                  style={{ width: `${Math.round(row.mrr_at_10 * 100)}%` }}
                                />
                              </span>
                              <span>{row.mrr_at_10.toFixed(3)}</span>
                            </div>
                          </td>
                          <td className="num mono">{row.ndcg_at_10.toFixed(3)}</td>
                          <td className="num mono">{row.p50_ms.toFixed(3)} ms</td>
                          <td className="num mono">{row.p95_ms.toFixed(3)} ms</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="two-col">
              <div className="card-block">
                <h3>Key Surprising Finding: Fixed vs. Heading Chunking</h3>
                <p className="prose">
                  Fixed-size 140-word windows (<code>298</code> chunks) beat heading-aware (
                  <code>430</code> chunks, MRR <code>0.970</code> vs <code>0.937</code>) and
                  sentence-window (<code>690</code> chunks, <code>0.903</code>). FastAPI docs have
                  many short 1–2 sentence sub-headings that leave MiniLM context-starved, whereas
                  heading-aware trades ~0.03 MRR for cleaner section titles when jumping back to a
                  page in the extension.
                </p>
                <div className="h2h-stats">
                  <div className="stat-box">
                    <span className="stat-label">Hybrid vs BM25 (heading)</span>
                    <span className="stat-val">
                      {handle.benchmarks.head_to_head_heading.hybrid_beats_bm25_mrr}W /{" "}
                      {handle.benchmarks.head_to_head_heading.hybrid_ties_bm25_mrr}T /{" "}
                      {handle.benchmarks.head_to_head_heading.bm25_beats_hybrid_mrr}L
                    </span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">Hybrid vs Vector (heading)</span>
                    <span className="stat-val">
                      {handle.benchmarks.head_to_head_heading.hybrid_beats_vector_mrr}W /{" "}
                      {handle.benchmarks.head_to_head_heading.hybrid_ties_vector_mrr}T /{" "}
                      {handle.benchmarks.head_to_head_heading.vector_beats_hybrid_mrr}L
                    </span>
                  </div>
                </div>
              </div>

              <div className="card-block">
                <h3>Native Rust Scaling (criterion, 384d)</h3>
                <p className="prose">
                  Why brute-force contiguous cosine instead of HNSW: even at 5,000 passages (~500
                  saved docs), exact dot-product + BM25 + RRF runs under 4 ms with zero graph
                  index overhead.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Passages</th>
                      <th className="num">BM25</th>
                      <th className="num">Cosine 384d</th>
                      <th className="num">Hybrid RRF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {handle.benchmarks.criterion_native.map((c) => (
                      <tr key={c.passages}>
                        <td className="mono">{c.passages.toLocaleString()}</td>
                        <td className="num mono">{c.bm25_ms.toFixed(3)} ms</td>
                        <td className="num mono">{c.cosine_ms.toFixed(3)} ms</td>
                        <td className="num mono em">{c.hybrid_ms.toFixed(3)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="two-col">
              <div className="card-block">
                <h3>Where BM25 Beat Vector</h3>
                <div className="case-list">
                  {handle.benchmarks.head_to_head_heading.bm25_wins_examples
                    .slice(0, 4)
                    .map((ex) => (
                      <div key={ex.id} className="case-item">
                        <div className="case-top">
                          <code>{ex.id}</code>
                          <span className={`cat cat-${ex.category}`}>{ex.category}</span>
                          <span className="case-ranks">
                            BM25 #{ex.bm25_rank} · Vec #{ex.vector_rank} · Hybrid #{ex.hybrid_rank}
                          </span>
                        </div>
                        <p className="case-q">&ldquo;{ex.query}&rdquo;</p>
                        <p className="case-note">
                          Expected <code>{ex.expected.join(", ")}</code>; Vector picked{" "}
                          <code>{ex.vector_top1}</code> #1.
                        </p>
                      </div>
                    ))}
                </div>
              </div>

              <div className="card-block">
                <h3>Where Vector Beat BM25</h3>
                <div className="case-list">
                  {handle.benchmarks.head_to_head_heading.vector_wins_examples
                    .slice(0, 4)
                    .map((ex) => (
                      <div key={ex.id} className="case-item">
                        <div className="case-top">
                          <code>{ex.id}</code>
                          <span className={`cat cat-${ex.category}`}>{ex.category}</span>
                          <span className="case-ranks">
                            BM25 #{ex.bm25_rank} · Vec #{ex.vector_rank} · Hybrid #{ex.hybrid_rank}
                          </span>
                        </div>
                        <p className="case-q">&ldquo;{ex.query}&rdquo;</p>
                        <p className="case-note">
                          Expected <code>{ex.expected.join(", ")}</code>; BM25 picked{" "}
                          <code>{ex.bm25_top1}</code> #1.
                        </p>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function cleanPreview(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
