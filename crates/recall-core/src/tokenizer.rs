use serde::{Deserialize, Serialize};

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "for", "from", "has", "have",
    "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "their", "then", "there",
    "these", "they", "this", "to", "was", "we", "were", "will", "with", "you", "your",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenizerConfig {
    pub filter_stopwords: bool,
    pub split_identifiers: bool,
    pub min_token_len: usize,
}

impl Default for TokenizerConfig {
    fn default() -> Self {
        Self {
            filter_stopwords: true,
            split_identifiers: true,
            min_token_len: 2,
        }
    }
}

pub fn tokenize(text: &str, config: &TokenizerConfig) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        if ch.is_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            emit_segment(&current, config, &mut tokens);
            current.clear();
        }
    }

    if !current.is_empty() {
        emit_segment(&current, config, &mut tokens);
    }

    tokens
}

fn emit_segment(segment: &str, config: &TokenizerConfig, out: &mut Vec<String>) {
    if config.split_identifiers {
        let parts = split_camel_case(segment);
        for part in parts {
            push_if_valid(&part.to_lowercase(), config, out);
        }
    } else {
        push_if_valid(&segment.to_lowercase(), config, out);
    }
}

fn push_if_valid(token: &str, config: &TokenizerConfig, out: &mut Vec<String>) {
    if token.len() < config.min_token_len {
        return;
    }
    if config.filter_stopwords && STOPWORDS.binary_search(&token).is_ok() {
        return;
    }
    out.push(token.to_string());
}

/// Splits camelCase and PascalCase identifiers while keeping acronyms and trailing digits intact.
/// Examples: "BackgroundTasks" -> ["Background", "Tasks"], "HTTPException" -> ["HTTP", "Exception"],
/// "OAuth2" -> ["OAuth2"], "FastAPI" -> ["Fast", "API"].
fn split_camel_case(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 1 {
        return vec![s.to_string()];
    }

    let mut parts = Vec::new();
    let mut start = 0;

    for i in 1..chars.len() {
        let prev = chars[i - 1];
        let curr = chars[i];
        let next = chars.get(i + 1).copied();

        let lower_to_upper = prev.is_lowercase() && curr.is_uppercase();
        let acronym_to_word = prev.is_uppercase()
            && curr.is_uppercase()
            && next.is_some_and(|n| n.is_lowercase())
            && (i - start) > 1;

        if lower_to_upper || acronym_to_word {
            parts.push(chars[start..i].iter().collect());
            start = i;
        }
    }

    parts.push(chars[start..].iter().collect());
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_snake_and_camel_identifiers() {
        let cfg = TokenizerConfig::default();
        assert_eq!(
            tokenize("BackgroundTasks and jsonable_encoder", &cfg),
            vec!["background", "tasks", "jsonable", "encoder"]
        );
    }

    #[test]
    fn handles_acronyms_and_numeric_suffixes() {
        let cfg = TokenizerConfig::default();
        assert_eq!(
            tokenize("HTTPException returns HTTP 503 for OAuth2", &cfg),
            vec!["http", "exception", "returns", "http", "503", "oauth2"]
        );
    }

    #[test]
    fn respects_stopword_flag() {
        let cfg = TokenizerConfig {
            filter_stopwords: false,
            ..Default::default()
        };
        assert_eq!(tokenize("in the path", &cfg), vec!["in", "the", "path"]);
    }

    #[test]
    fn stopwords_array_is_sorted_for_binary_search() {
        for pair in STOPWORDS.windows(2) {
            assert!(
                pair[0] < pair[1],
                "STOPWORDS out of order: {} >= {}",
                pair[0],
                pair[1]
            );
        }
    }
}
