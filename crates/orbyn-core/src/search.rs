//! Finding a message across threads. Every word must appear in one message, in any
//! order, ignoring case. `LIKE` narrows the rows and ignores case only in ASCII, so
//! the final word check runs here, where any script folds.

use orbyn_contracts::{MessageHit, MessageSearch};
use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;

use crate::error::{CoreError, Result};
use crate::store::Store;

const MIN_WORD: usize = 3;
/// These scripts have no spaces, and two characters already make a word.
const MIN_CJK_WORD: usize = 2;
const MAX_QUERY_CHARS: usize = 200;
const MAX_WORDS: usize = 16;
const DEFAULT_HITS: usize = 50;
const MAX_HITS: usize = 200;
/// How many messages one search reads, newest first.
const MAX_SCAN: usize = 50_000;
/// Characters shown on each side of a match.
const SNIPPET_SIDE: usize = 80;

/// What to search. Empty fields mean everything live.
#[derive(Clone, Debug, Default)]
pub struct SearchScope {
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub archived: bool,
    pub limit: Option<usize>,
}

/// Han, Kana, Hangul and their punctuation-free extensions.
fn is_cjk(c: char) -> bool {
    matches!(u32::from(c),
        0x3040..=0x30FF | 0x31F0..=0x31FF
        | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
        | 0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF
        | 0xFF66..=0xFF9F | 0x20000..=0x323AF)
}

fn long_enough(word: &str) -> bool {
    let count = word.chars().count();
    let needed = if word.chars().any(is_cjk) {
        MIN_CJK_WORD
    } else {
        MIN_WORD
    };
    count >= needed
}

/// Escapes `LIKE`'s own characters so a person's `%` is only a `%`.
fn like_pattern(word: &str) -> String {
    let mut pattern = String::with_capacity(word.len() + 2);
    pattern.push('%');
    for c in word.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

/// The words of a query, lower-cased, each once.
fn words_of(query: &str) -> Result<Vec<String>> {
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(CoreError::Invalid("That search is too long.".into()));
    }
    let mut words: Vec<String> = Vec::new();
    for word in query.split_whitespace() {
        let word = word.to_lowercase();
        if !words.contains(&word) {
            words.push(word);
        }
    }
    if words.len() > MAX_WORDS {
        return Err(CoreError::Invalid("That search has too many words.".into()));
    }
    Ok(words)
}

/// The text around the first word found, cut on character boundaries.
fn snippet(text: &str, lowered: &str, words: &[String]) -> String {
    let at = words
        .iter()
        .filter_map(|word| lowered.find(word.as_str()))
        .min()
        .unwrap_or(0);
    // Lower-casing can change a character's length, so go by characters.
    let total = text.chars().count();
    let hit = lowered[..at].chars().count().min(total);
    let start = hit.saturating_sub(SNIPPET_SIDE);
    let end = (hit + SNIPPET_SIDE * 2).min(total);
    let body: String = text.chars().skip(start).take(end - start).collect();
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let lead = if start > 0 { "…" } else { "" };
    let tail = if end < total { "…" } else { "" };
    format!("{lead}{body}{tail}")
}

impl Store {
    pub fn search_messages(&self, query: &str, scope: &SearchScope) -> Result<MessageSearch> {
        let words = words_of(query)?;
        if !words.iter().any(|word| long_enough(word)) {
            return Ok(MessageSearch {
                hits: Vec::new(),
                words,
                too_short: true,
                truncated: false,
            });
        }
        let limit = scope.limit.unwrap_or(DEFAULT_HITS).clamp(1, MAX_HITS);
        let mut sql = String::from(
            "SELECT m.thread_id, t.title, t.project_id, m.message_id, m.seq, m.role, m.ts, m.text
             FROM thread_messages m JOIN threads t ON t.id = m.thread_id
             WHERE (t.archived_at IS NOT NULL) = ?",
        );
        let mut values = vec![SqlValue::from(scope.archived)];
        if let Some(project) = &scope.project_id {
            sql.push_str(" AND t.project_id = ?");
            values.push(project.clone().into());
        }
        if let Some(thread) = &scope.thread_id {
            sql.push_str(" AND m.thread_id = ?");
            values.push(thread.clone().into());
        }
        for word in words.iter().filter(|word| word.is_ascii()) {
            sql.push_str(" AND m.text LIKE ? ESCAPE '\\'");
            values.push(like_pattern(word).into());
        }
        sql.push_str(" ORDER BY m.ts DESC, m.seq DESC LIMIT ?");
        values.push(SqlValue::from(i64::try_from(MAX_SCAN).unwrap_or(i64::MAX)));

        let conn = self.reader();
        let mut statement = conn.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(values))?;
        let (mut hits, mut read, mut truncated) = (Vec::new(), 0, false);
        while let Some(row) = rows.next()? {
            read += 1;
            let text: String = row.get(7)?;
            let lowered = text.to_lowercase();
            if !words.iter().all(|word| lowered.contains(word.as_str())) {
                continue;
            }
            if hits.len() == limit {
                truncated = true;
                break;
            }
            hits.push(MessageHit {
                thread_id: row.get(0)?,
                thread_title: row.get(1)?,
                project_id: row.get(2)?,
                message_id: row.get(3)?,
                seq: row.get(4)?,
                role: row.get(5)?,
                ts: row.get(6)?,
                snippet: snippet(&text, &lowered, &words),
            });
        }
        Ok(MessageSearch {
            hits,
            words,
            too_short: false,
            truncated: truncated || read == MAX_SCAN,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_minimum_depends_on_the_script() {
        for short in ["a", "ab", "好", "の"] {
            assert!(!long_enough(short), "{short}");
        }
        for fine in ["abc", "修复", "ログ", "검색", "aé1"] {
            assert!(long_enough(fine), "{fine}");
        }
    }

    #[test]
    fn like_characters_stay_literal() {
        assert_eq!(like_pattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
    }

    #[test]
    fn words_repeat_once_and_long_queries_are_refused() {
        assert_eq!(words_of("Fix fix  LOGIN").unwrap(), ["fix", "login"]);
        assert!(words_of(&"a".repeat(201)).is_err());
        let many = (0..17)
            .map(|n| format!("w{n}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(words_of(&many).is_err());
    }

    #[test]
    fn a_snippet_centres_on_the_match_and_never_splits_a_character() {
        let text = format!("{}NEEDLE{}", "é".repeat(300), "ß".repeat(300));
        let lowered = text.to_lowercase();
        let shown = snippet(&text, &lowered, &["needle".to_owned()]);
        assert!(shown.starts_with('…') && shown.ends_with('…'));
        assert!(shown.contains("NEEDLE"));
        assert_eq!(snippet("short", "short", &["short".to_owned()]), "short");
        // A letter whose lower case is longer must not shift the cut past the text.
        let turkish = "İ".repeat(10);
        let lowered = turkish.to_lowercase();
        assert!(!snippet(&turkish, &lowered, &["i".to_owned()]).is_empty());
    }
}
