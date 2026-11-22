use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use recall_core::{chunk_document, ChunkingStrategy, RecallIndex};
use serde::Deserialize;

const DEFAULT_EMBEDDING_DIM: usize = 384;

#[derive(Debug, Deserialize)]
struct CorpusManifest {
    documents: Vec<ManifestDoc>,
}

#[derive(Debug, Deserialize)]
struct ManifestDoc {
    doc_id: String,
    filename: String,
    title: String,
    url: String,
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
        print_usage();
        return ExitCode::SUCCESS;
    }

    let result = match args[0].as_str() {
        "index" => run_index(&args[1..]),
        "search" => run_search(&args[1..]),
        "stats" => run_stats(&args[1..]),
        "chunk" => run_chunk(&args[1..]),
        other => Err(format!("unknown subcommand: {other}")),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run_index(args: &[String]) -> Result<(), String> {
    let manifest_path = PathBuf::from(
        flag_value(args, "--manifest").unwrap_or_else(|| "eval/corpus_manifest.json".into()),
    );
    let corpus_dir =
        PathBuf::from(flag_value(args, "--corpus-dir").unwrap_or_else(|| "eval/corpus".into()));
    let chunker_name = flag_value(args, "--chunker").unwrap_or_else(|| "heading".into());
    let out_path = PathBuf::from(
        flag_value(args, "--out").ok_or_else(|| "missing required --out <path>".to_string())?,
    );

    let strategy = parse_chunker(&chunker_name)?;
    let manifest_raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("failed to read manifest {}: {e}", manifest_path.display()))?;
    let manifest: CorpusManifest =
        serde_json::from_str(&manifest_raw).map_err(|e| format!("invalid manifest json: {e}"))?;

    let started = Instant::now();
    let mut index =
        RecallIndex::new(DEFAULT_EMBEDDING_DIM).map_err(|e| format!("index init failed: {e}"))?;

    for doc in &manifest.documents {
        let doc_path = corpus_dir.join(&doc.filename);
        let text = fs::read_to_string(&doc_path)
            .map_err(|e| format!("failed to read {}: {e}", doc_path.display()))?;
        let chunks = chunk_document(&text, &strategy)
            .map_err(|e| format!("chunking failed for {}: {e}", doc.doc_id))?;
        index
            .upsert_document(&doc.doc_id, &doc.url, &doc.title, 0, chunks, None)
            .map_err(|e| format!("indexing failed for {}: {e}", doc.doc_id))?;
    }

    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create directory {}: {e}", parent.display()))?;
        }
    }

    let snapshot = index
        .to_json()
        .map_err(|e| format!("serialization failed: {e}"))?;
    fs::write(&out_path, snapshot)
        .map_err(|e| format!("failed to write {}: {e}", out_path.display()))?;

    let stats = index.stats();
    println!(
        "indexed {} docs -> {} chunks (vocab: {}, strategy: {}) in {:.2} ms -> {}",
        stats.document_count,
        stats.chunk_count,
        stats.vocab_size,
        chunker_name,
        started.elapsed().as_secs_f64() * 1000.0,
        out_path.display()
    );
    Ok(())
}

fn run_search(args: &[String]) -> Result<(), String> {
    let index_path = PathBuf::from(
        flag_value(args, "--index").ok_or_else(|| "missing required --index <path>".to_string())?,
    );
    let query =
        flag_value(args, "--query").ok_or_else(|| "missing required --query <text>".to_string())?;
    let top_k: usize = flag_value(args, "--top-k")
        .map(|s| s.parse().map_err(|_| format!("invalid --top-k value: {s}")))
        .transpose()?
        .unwrap_or(5);

    let index = load_index(&index_path)?;
    let started = Instant::now();
    let results = index.search_keyword(&query, top_k);
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

    println!(
        "query: {:?} ({} hits in {:.3} ms)\n",
        query,
        results.len(),
        elapsed_ms
    );

    for (i, hit) in results.iter().enumerate() {
        let heading = hit.heading.as_deref().unwrap_or("(intro)");
        let preview = truncate_preview(&hit.text, 180);
        println!(
            "{}. [score={:.3}] {} > {}",
            i + 1,
            hit.score,
            hit.title,
            heading
        );
        println!("   {preview}");
        println!("   {}\n", hit.jump_url);
    }

    Ok(())
}

fn run_stats(args: &[String]) -> Result<(), String> {
    let index_path = PathBuf::from(
        flag_value(args, "--index").ok_or_else(|| "missing required --index <path>".to_string())?,
    );
    let index = load_index(&index_path)?;
    let stats = index.stats();
    let json =
        serde_json::to_string_pretty(&stats).map_err(|e| format!("failed to format stats: {e}"))?;
    println!("{json}");
    Ok(())
}

fn run_chunk(args: &[String]) -> Result<(), String> {
    let file_path = PathBuf::from(
        flag_value(args, "--file").ok_or_else(|| "missing required --file <path>".to_string())?,
    );
    let chunker_name = flag_value(args, "--chunker").unwrap_or_else(|| "heading".into());
    let strategy = parse_chunker(&chunker_name)?;
    let text = fs::read_to_string(&file_path)
        .map_err(|e| format!("failed to read {}: {e}", file_path.display()))?;
    let chunks = chunk_document(&text, &strategy).map_err(|e| format!("chunking failed: {e}"))?;

    println!(
        "{} -> {} chunks (strategy: {chunker_name})\n",
        file_path.display(),
        chunks.len()
    );
    for chunk in &chunks {
        let heading = chunk.heading.as_deref().unwrap_or("(no heading)");
        let words = chunk.text.split_whitespace().count();
        println!(
            "[#{:02}] ({words}w) {heading}\n     {}\n",
            chunk.chunk_index,
            truncate_preview(&chunk.text, 140)
        );
    }
    Ok(())
}

fn load_index(path: &Path) -> Result<RecallIndex, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("failed to read index {}: {e}", path.display()))?;
    RecallIndex::from_json(&raw).map_err(|e| format!("invalid index snapshot: {e}"))
}

fn parse_chunker(name: &str) -> Result<ChunkingStrategy, String> {
    match name {
        "fixed" => Ok(ChunkingStrategy::fixed_default()),
        "heading" => Ok(ChunkingStrategy::heading_default()),
        "sentence" => Ok(ChunkingStrategy::sentence_default()),
        other => Err(format!(
            "unknown chunker '{other}' (expected: fixed, heading, sentence)"
        )),
    }
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let preview: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

fn print_usage() {
    println!(
        "\
recall-cli - local hybrid search CLI for Recall

USAGE:
  recall-cli index  --out <index.json> [--manifest <path>] [--corpus-dir <dir>] [--chunker fixed|heading|sentence]
  recall-cli search --index <index.json> --query <text> [--top-k 5]
  recall-cli stats  --index <index.json>
  recall-cli chunk  --file <doc.md> [--chunker fixed|heading|sentence]"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_chunker_names() {
        assert_eq!(
            parse_chunker("fixed").unwrap(),
            ChunkingStrategy::fixed_default()
        );
        assert_eq!(
            parse_chunker("heading").unwrap(),
            ChunkingStrategy::heading_default()
        );
        assert_eq!(
            parse_chunker("sentence").unwrap(),
            ChunkingStrategy::sentence_default()
        );
        assert!(parse_chunker("unknown").is_err());
    }

    #[test]
    fn extracts_flag_values_and_truncates_unicode_safely() {
        let args = vec![
            "--query".to_string(),
            "cors wildcard".to_string(),
            "--top-k".to_string(),
            "3".to_string(),
        ];
        assert_eq!(
            flag_value(&args, "--query").as_deref(),
            Some("cors wildcard")
        );
        assert_eq!(flag_value(&args, "--top-k").as_deref(), Some("3"));
        assert_eq!(flag_value(&args, "--missing"), None);

        assert_eq!(truncate_preview("short", 10), "short");
        assert_eq!(truncate_preview("hello world", 5), "hello...");
    }
}
