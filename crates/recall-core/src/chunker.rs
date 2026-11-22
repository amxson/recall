use serde::{Deserialize, Serialize};

use crate::error::RecallError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChunkingStrategy {
    FixedSize {
        max_words: usize,
        overlap_words: usize,
    },
    HeadingAware {
        max_words: usize,
        overlap_words: usize,
    },
    SentenceWindow {
        sentences_per_chunk: usize,
        overlap_sentences: usize,
    },
}

impl ChunkingStrategy {
    pub fn fixed_default() -> Self {
        Self::FixedSize {
            max_words: 140,
            overlap_words: 25,
        }
    }

    pub fn heading_default() -> Self {
        Self::HeadingAware {
            max_words: 180,
            overlap_words: 30,
        }
    }

    pub fn sentence_default() -> Self {
        Self::SentenceWindow {
            sentences_per_chunk: 4,
            overlap_sentences: 1,
        }
    }

    pub fn validate(&self) -> Result<(), RecallError> {
        match *self {
            Self::FixedSize {
                max_words,
                overlap_words,
            }
            | Self::HeadingAware {
                max_words,
                overlap_words,
            } => {
                if max_words == 0 {
                    return Err(RecallError::InvalidConfig(
                        "max_words must be greater than zero".into(),
                    ));
                }
                if overlap_words >= max_words {
                    return Err(RecallError::InvalidConfig(
                        "overlap_words must be smaller than max_words".into(),
                    ));
                }
            }
            Self::SentenceWindow {
                sentences_per_chunk,
                overlap_sentences,
            } => {
                if sentences_per_chunk == 0 {
                    return Err(RecallError::InvalidConfig(
                        "sentences_per_chunk must be greater than zero".into(),
                    ));
                }
                if overlap_sentences >= sentences_per_chunk {
                    return Err(RecallError::InvalidConfig(
                        "overlap_sentences must be smaller than sentences_per_chunk".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DraftChunk {
    pub chunk_index: usize,
    pub heading: Option<String>,
    pub text: String,
    pub anchor_phrase: String,
}

pub fn chunk_document(
    text: &str,
    strategy: &ChunkingStrategy,
) -> Result<Vec<DraftChunk>, RecallError> {
    strategy.validate()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let raw_chunks = match *strategy {
        ChunkingStrategy::FixedSize {
            max_words,
            overlap_words,
        } => chunk_fixed(trimmed, None, max_words, overlap_words),
        ChunkingStrategy::HeadingAware {
            max_words,
            overlap_words,
        } => chunk_by_headings(trimmed, max_words, overlap_words),
        ChunkingStrategy::SentenceWindow {
            sentences_per_chunk,
            overlap_sentences,
        } => chunk_by_sentences(trimmed, sentences_per_chunk, overlap_sentences),
    };

    Ok(raw_chunks
        .into_iter()
        .enumerate()
        .map(|(idx, (heading, body))| {
            let anchor_phrase = extract_anchor_phrase(&body);
            DraftChunk {
                chunk_index: idx,
                heading,
                text: body,
                anchor_phrase,
            }
        })
        .collect())
}

fn chunk_fixed(
    text: &str,
    heading: Option<String>,
    max_words: usize,
    overlap_words: usize,
) -> Vec<(Option<String>, String)> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }

    let step = max_words - overlap_words;
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < words.len() {
        let end = (start + max_words).min(words.len());
        chunks.push((heading.clone(), words[start..end].join(" ")));
        if end == words.len() {
            break;
        }
        start += step;
    }

    chunks
}

fn chunk_by_headings(
    text: &str,
    max_words: usize,
    overlap_words: usize,
) -> Vec<(Option<String>, String)> {
    let mut sections: Vec<(Option<String>, String)> = Vec::new();
    let mut current_heading: Option<String> = None;
    let mut current_lines: Vec<&str> = Vec::new();
    let mut in_code_fence = false;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_code_fence = !in_code_fence;
            current_lines.push(line);
            continue;
        }

        if !in_code_fence && is_markdown_heading(trimmed) {
            let body = current_lines.join("\n").trim().to_string();
            if !body.is_empty() {
                sections.push((current_heading.clone(), body));
            }
            current_heading = Some(strip_heading_hashes(trimmed));
            current_lines.clear();
        } else {
            current_lines.push(line);
        }
    }

    let trailing = current_lines.join("\n").trim().to_string();
    if !trailing.is_empty() {
        sections.push((current_heading, trailing));
    }

    let mut chunks = Vec::new();
    for (heading, body) in sections {
        let word_count = body.split_whitespace().count();
        if word_count <= max_words {
            chunks.push((heading, normalize_whitespace(&body)));
        } else {
            chunks.extend(chunk_fixed(&body, heading, max_words, overlap_words));
        }
    }
    chunks
}

fn chunk_by_sentences(
    text: &str,
    sentences_per_chunk: usize,
    overlap_sentences: usize,
) -> Vec<(Option<String>, String)> {
    let mut heading: Option<String> = None;
    let mut paragraphs: Vec<(Option<String>, Vec<String>)> = Vec::new();
    let mut current_block = String::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if is_markdown_heading(trimmed) {
            if !current_block.trim().is_empty() {
                let sents = split_sentences(&current_block);
                if !sents.is_empty() {
                    paragraphs.push((heading.clone(), sents));
                }
                current_block.clear();
            }
            heading = Some(strip_heading_hashes(trimmed));
            continue;
        }

        if trimmed.is_empty() {
            if !current_block.trim().is_empty() {
                let sents = split_sentences(&current_block);
                if !sents.is_empty() {
                    paragraphs.push((heading.clone(), sents));
                }
                current_block.clear();
            }
        } else {
            if !current_block.is_empty() {
                current_block.push(' ');
            }
            current_block.push_str(trimmed);
        }
    }

    if !current_block.trim().is_empty() {
        let sents = split_sentences(&current_block);
        if !sents.is_empty() {
            paragraphs.push((heading, sents));
        }
    }

    // Flatten into (heading, sentence) pairs so sliding windows preserve section context
    let mut flat: Vec<(Option<String>, String)> = Vec::new();
    for (sec_heading, sents) in paragraphs {
        for s in sents {
            flat.push((sec_heading.clone(), s));
        }
    }

    if flat.is_empty() {
        return Vec::new();
    }

    let step = sentences_per_chunk - overlap_sentences;
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < flat.len() {
        let end = (start + sentences_per_chunk).min(flat.len());
        let chunk_heading = flat[start].0.clone();
        let joined = flat[start..end]
            .iter()
            .map(|(_, s)| s.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        chunks.push((chunk_heading, joined));
        if end == flat.len() {
            break;
        }
        start += step;
    }

    chunks
}

fn split_sentences(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut sentences = Vec::new();
    let mut start = 0;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        let is_ender = matches!(c, '.' | '!' | '?');
        if is_ender {
            let next_is_space = i + 1 < chars.len() && chars[i + 1].is_whitespace();
            let after_space_starts_sentence = chars
                .iter()
                .skip(i + 1)
                .find(|ch| !ch.is_whitespace())
                .is_some_and(|ch| ch.is_uppercase() || matches!(ch, '"' | '\'' | '`' | '('));

            // Avoid splitting on version numbers like "3.11" or abbreviations like "e.g."
            let prev_is_digit = i > 0 && chars[i - 1].is_ascii_digit();
            let looks_like_abbrev = i >= 2 && chars[i - 2] == '.' && chars[i - 1].is_alphabetic();

            if next_is_space && after_space_starts_sentence && !prev_is_digit && !looks_like_abbrev
            {
                let piece: String = chars[start..=i].iter().collect();
                let cleaned = normalize_whitespace(&piece);
                if !cleaned.is_empty() {
                    sentences.push(cleaned);
                }
                start = i + 1;
            }
        }
        i += 1;
    }

    if start < chars.len() {
        let piece: String = chars[start..].iter().collect();
        let cleaned = normalize_whitespace(&piece);
        if !cleaned.is_empty() {
            sentences.push(cleaned);
        }
    }

    sentences
}

fn is_markdown_heading(trimmed_line: &str) -> bool {
    let hashes = trimmed_line.bytes().take_while(|&b| b == b'#').count();
    (1..=6).contains(&hashes) && trimmed_line.as_bytes().get(hashes) == Some(&b' ')
}

fn strip_heading_hashes(trimmed_line: &str) -> String {
    trimmed_line.trim_start_matches('#').trim().replace('`', "")
}

fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extracts a clean plain-text phrase (up to 7 words) suitable for Chrome `#:~:text=` fragments.
/// Strips markdown links `[label](url)` -> `label`, inline HTML tags, and formatting punctuation.
fn extract_anchor_phrase(text: &str) -> String {
    let no_links = strip_markdown_links(text);
    let no_html = strip_html_tags(&no_links);
    let cleaned: String = no_html
        .chars()
        .map(|c| {
            if matches!(c, '`' | '*' | '_' | '[' | ']' | '#' | '>' | '"') {
                ' '
            } else {
                c
            }
        })
        .collect();

    cleaned
        .split_whitespace()
        .take(7)
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_markdown_links(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(close_bracket) = chars[i + 1..].iter().position(|&c| c == ']') {
                let close_idx = i + 1 + close_bracket;
                if close_idx + 1 < chars.len() && chars[close_idx + 1] == '(' {
                    if let Some(close_paren) = chars[close_idx + 2..].iter().position(|&c| c == ')')
                    {
                        for &ch in &chars[i + 1..close_idx] {
                            out.push(ch);
                        }
                        i = close_idx + 2 + close_paren + 1;
                        continue;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_overlap_configs() {
        let bad_fixed = ChunkingStrategy::FixedSize {
            max_words: 50,
            overlap_words: 50,
        };
        assert!(chunk_document("hello world", &bad_fixed).is_err());

        let bad_sent = ChunkingStrategy::SentenceWindow {
            sentences_per_chunk: 2,
            overlap_sentences: 3,
        };
        assert!(chunk_document("One. Two.", &bad_sent).is_err());
    }

    #[test]
    fn fixed_size_respects_window_and_overlap() {
        let text = (0..12)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let strategy = ChunkingStrategy::FixedSize {
            max_words: 5,
            overlap_words: 2,
        };
        let chunks = chunk_document(&text, &strategy).unwrap();
        assert_eq!(chunks.len(), 4);
        assert_eq!(chunks[0].text, "w0 w1 w2 w3 w4");
        assert_eq!(chunks[1].text, "w3 w4 w5 w6 w7");
        assert_eq!(chunks[2].text, "w6 w7 w8 w9 w10");
        assert_eq!(chunks[3].text, "w9 w10 w11");
    }

    #[test]
    fn heading_aware_preserves_sections_and_ignores_code_fence_comments() {
        let doc = "\
# Background Tasks

Run tasks after returning a response.

```python
# This comment inside code is not a heading
def send_email():
    pass
```

## Dependency Injection

BackgroundTasks works inside dependencies too.
";
        let chunks = chunk_document(doc, &ChunkingStrategy::heading_default()).unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].heading.as_deref(), Some("Background Tasks"));
        assert!(chunks[0].text.contains("def send_email"));
        assert_eq!(chunks[1].heading.as_deref(), Some("Dependency Injection"));
        assert!(chunks[1].text.contains("works inside dependencies"));
    }

    #[test]
    fn sentence_window_splits_sentences_without_breaking_versions() {
        let doc = "FastAPI works on Python 3.11 and newer. It validates request bodies with Pydantic. Responses can filter sensitive fields. Background tasks run after responses. Middleware wraps every request.";
        let strategy = ChunkingStrategy::SentenceWindow {
            sentences_per_chunk: 2,
            overlap_sentences: 1,
        };
        let chunks = chunk_document(doc, &strategy).unwrap();
        assert_eq!(chunks.len(), 4);
        assert!(chunks[0].text.contains("Python 3.11"));
        assert!(chunks[0].text.contains("Pydantic."));
        assert!(chunks[1].text.contains("Pydantic."));
        assert!(chunks[1].text.contains("sensitive fields."));
    }

    #[test]
    fn anchor_phrase_strips_markdown_punctuation() {
        let doc = "## Using `BackgroundTasks`\n\n**FastAPI** creates the `BackgroundTasks` object for you automatically.";
        let chunks = chunk_document(doc, &ChunkingStrategy::heading_default()).unwrap();
        assert_eq!(
            chunks[0].anchor_phrase,
            "FastAPI creates the BackgroundTasks object for you"
        );
    }

    #[test]
    fn anchor_phrase_strips_markdown_links_and_inline_html() {
        let doc = r#"[CORS or "Cross-Origin Resource Sharing"](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) refers to <abbr title="Cross-Origin Resource Sharing">CORS</abbr> browser rules."#;
        let chunks = chunk_document(doc, &ChunkingStrategy::fixed_default()).unwrap();
        assert_eq!(
            chunks[0].anchor_phrase,
            "CORS or Cross-Origin Resource Sharing refers to"
        );
        assert!(!chunks[0].anchor_phrase.contains("https://"));
        assert!(!chunks[0].anchor_phrase.contains("abbr"));
    }
}
