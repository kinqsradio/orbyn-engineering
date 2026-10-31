//! Usage from each engine's own local session history. Only timestamps, models
//! and token counts leave a file, and only history files are opened: no credential
//! file is ever read. Files are large, so they are streamed and unchanged ones
//! are served from memory.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use orbyn_contracts::{
    DailyUsage, EngineLimits, EngineUsage, ModelPrice, ModelUsage, ServerSettings, UsageReport,
};
use serde_json::Value;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::util::{new_id, now, write_private};

const LIMITS_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    fn add(&mut self, other: Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }

    fn total(self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

/// `(day, model) -> tokens` for one file.
type FileTotals = BTreeMap<(String, String), Tokens>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Engine {
    Claude,
    Codex,
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn day_of(entry: &Value) -> String {
    entry
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|stamp| stamp.get(..10))
        .unwrap_or("unknown")
        .to_owned()
}

/// Claude writes a message repeatedly as it streams, so the last line of each
/// message stands. Input and cache counts are already separate.
pub fn scan_claude(reader: impl BufRead) -> FileTotals {
    let mut messages: HashMap<String, (String, String, Tokens)> = HashMap::new();
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(message) = entry.get("message") else {
            continue;
        };
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            continue;
        };
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        messages.insert(
            id.to_owned(),
            (
                day_of(&entry),
                model,
                Tokens {
                    input: number(usage, "input_tokens"),
                    output: number(usage, "output_tokens"),
                    cache_read: number(usage, "cache_read_input_tokens"),
                    cache_write: number(usage, "cache_creation_input_tokens"),
                },
            ),
        );
    }
    let mut totals = FileTotals::new();
    for (day, model, tokens) in messages.into_values() {
        totals.entry((day, model)).or_default().add(tokens);
    }
    totals
}

/// Codex logs a running total with each turn, and repeats it unchanged. Its input
/// count includes cached input, so that part is moved out.
pub fn scan_codex(reader: impl BufRead) -> FileTotals {
    let mut totals = FileTotals::new();
    let mut model = "unknown".to_owned();
    let mut last_total = None;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("token_count") && !line.contains("turn_context") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = entry.get("payload").unwrap_or(&Value::Null);
        if entry.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(name) = payload.get("model").and_then(Value::as_str) {
                model = name.to_owned();
            }
            continue;
        }
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(info) = payload.get("info").filter(|info| !info.is_null()) else {
            continue;
        };
        let total = info
            .pointer("/total_token_usage/total_tokens")
            .and_then(Value::as_u64);
        if total == last_total {
            continue;
        }
        last_total = total;
        let Some(last) = info.get("last_token_usage") else {
            continue;
        };
        let cached = number(last, "cached_input_tokens");
        totals
            .entry((day_of(&entry), model.clone()))
            .or_default()
            .add(Tokens {
                input: number(last, "input_tokens").saturating_sub(cached),
                output: number(last, "output_tokens"),
                cache_read: cached,
                cache_write: number(last, "cache_write_input_tokens"),
            });
    }
    totals
}

fn jsonl_files(root: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // History is plain folders; a symlink could lead anywhere.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            jsonl_files(&path, found);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            found.push(path);
        }
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn history_root(engine: Engine) -> Option<PathBuf> {
    match engine {
        Engine::Claude => std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(|| home().map(|home| home.join(".claude")))
            .map(|root| root.join("projects")),
        Engine::Codex => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| home().map(|home| home.join(".codex")))
            .map(|root| root.join("sessions")),
    }
}

/// What a file held when last read, keyed by its size and modified time.
#[derive(Clone)]
struct Cached {
    size: u64,
    modified: Option<SystemTime>,
    totals: FileTotals,
}

#[derive(Default)]
struct ScanCache {
    files: HashMap<PathBuf, Cached>,
}

fn scan_engine(engine: Engine, cache: &mut ScanCache) -> (String, u32, u32, FileTotals) {
    let Some(root) = history_root(engine).filter(|root| root.is_dir()) else {
        return ("no_history".to_owned(), 0, 0, FileTotals::new());
    };
    let mut files = Vec::new();
    jsonl_files(&root, &mut files);
    let (mut scanned, mut skipped) = (0, 0);
    let mut combined = FileTotals::new();
    for path in files {
        let Ok(meta) = std::fs::metadata(&path) else {
            skipped += 1;
            continue;
        };
        let (size, modified) = (meta.len(), meta.modified().ok());
        let cached = cache
            .files
            .get(&path)
            .filter(|entry| entry.size == size && entry.modified == modified)
            .map(|entry| entry.totals.clone());
        let totals = match cached {
            Some(totals) => totals,
            None => {
                let Ok(file) = std::fs::File::open(&path) else {
                    skipped += 1;
                    continue;
                };
                let reader = BufReader::new(file);
                let totals = match engine {
                    Engine::Claude => scan_claude(reader),
                    Engine::Codex => scan_codex(reader),
                };
                cache.files.insert(
                    path,
                    Cached {
                        size,
                        modified,
                        totals: totals.clone(),
                    },
                );
                totals
            }
        };
        scanned += 1;
        for (key, tokens) in totals {
            combined.entry(key).or_default().add(tokens);
        }
    }
    ("scanned".to_owned(), scanned, skipped, combined)
}

fn cost(tokens: Tokens, price: &ModelPrice) -> f64 {
    let rate = |count: u64, per_million: f64| count as f64 / 1_000_000.0 * per_million;
    rate(tokens.input, price.input)
        + rate(tokens.output, price.output)
        + rate(tokens.cache_read, price.cache_read)
        + rate(tokens.cache_write, price.cache_write)
}

fn summarize(
    engine: &str,
    (status, scanned, skipped, totals): (String, u32, u32, FileTotals),
    settings: &ServerSettings,
) -> EngineUsage {
    let resolve = |model: &str| {
        settings
            .model_aliases
            .iter()
            .find(|alias| alias.model == model)
            .map_or_else(|| model.to_owned(), |alias| alias.counts_as.clone())
    };
    let mut models: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut days: BTreeMap<String, u64> = BTreeMap::new();
    for ((day, model), tokens) in totals {
        models.entry(resolve(&model)).or_default().add(tokens);
        *days.entry(day).or_default() += tokens.total();
    }
    EngineUsage {
        engine: engine.to_owned(),
        status,
        files_scanned: scanned,
        files_skipped: skipped,
        models: models
            .into_iter()
            .map(|(model, tokens)| ModelUsage {
                estimated_cost: settings
                    .model_prices
                    .iter()
                    .find(|price| price.model == model)
                    .map(|price| cost(tokens, price)),
                model,
                input_tokens: tokens.input,
                output_tokens: tokens.output,
                cache_read_tokens: tokens.cache_read,
                cache_write_tokens: tokens.cache_write,
            })
            .collect(),
        days: days
            .into_iter()
            .map(|(date, tokens)| DailyUsage { date, tokens })
            .collect(),
    }
}

pub struct UsageCenter {
    host_id: String,
    cache: Arc<Mutex<ScanCache>>,
    limits: Mutex<HashMap<String, (Instant, EngineLimits)>>,
}

impl UsageCenter {
    /// Keeps a stable id for this machine in app data.
    pub fn new(data_dir: &Path) -> Result<Self> {
        let path = data_dir.join("host-id");
        let host_id = match std::fs::read_to_string(&path) {
            Ok(text) if !text.trim().is_empty() => text.trim().to_owned(),
            _ => {
                let id = new_id();
                write_private(&path, id.as_bytes())?;
                id
            }
        };
        Ok(Self {
            host_id,
            cache: Arc::default(),
            limits: Mutex::new(HashMap::new()),
        })
    }

    /// Scans off the async threads, since history can run to gigabytes. Unchanged
    /// files come from memory, so a scan is cheap and a price change shows at once.
    pub async fn report(&self, settings: &ServerSettings) -> Result<UsageReport> {
        let cache = self.cache.clone();
        let scans = tokio::task::spawn_blocking(move || {
            let mut cache = cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            [
                ("claude", scan_engine(Engine::Claude, &mut cache)),
                ("codex", scan_engine(Engine::Codex, &mut cache)),
            ]
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        Ok(UsageReport {
            host_id: self.host_id.clone(),
            scanned_at: now(),
            engines: scans
                .into_iter()
                .map(|(name, scan)| summarize(name, scan, settings))
                .collect(),
        })
    }

    fn cached_limits(&self, id: &str) -> Option<EngineLimits> {
        self.limits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .filter(|(at, _)| at.elapsed() < LIMITS_TTL)
            .map(|(_, limits)| limits.clone())
    }

    fn keep_limits(&self, limits: &EngineLimits) {
        self.limits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(limits.engine.clone(), (Instant::now(), limits.clone()));
    }
}

impl Core {
    /// An engine's own limit report, at most once per five minutes.
    pub async fn engine_limits(&self, id: &str) -> Result<EngineLimits> {
        if let Some(cached) = self.usage.cached_limits(id) {
            return Ok(cached);
        }
        let report = self.engines.driver(id)?.limits().await?.ok_or_else(|| {
            CoreError::Unsupported("This engine does not report its limits.".into())
        })?;
        let limits = EngineLimits {
            engine: id.to_owned(),
            checked_at: now(),
            limits: report,
        };
        self.usage.keep_limits(&limits);
        Ok(limits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbyn_contracts::ModelAlias;

    fn lines(items: &[&str]) -> std::io::Cursor<Vec<u8>> {
        std::io::Cursor::new(items.join("\n").into_bytes())
    }

    fn only(totals: &FileTotals) -> Tokens {
        assert_eq!(totals.len(), 1, "{totals:?}");
        *totals.values().next().unwrap()
    }

    #[test]
    fn claude_counts_a_streamed_message_once_with_its_final_numbers() {
        let totals = scan_claude(lines(&[
            r#"{"timestamp":"2026-10-30T01:00:00Z","message":{"id":"m1","model":"opus","usage":{"input_tokens":5,"output_tokens":1}}}"#,
            r#"{"timestamp":"2026-10-30T01:00:01Z","message":{"id":"m1","model":"opus","usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}"#,
            "not json with \"usage\" in it",
            r#"{"message":{"usage":{"input_tokens":100}}}"#,
        ]));
        assert_eq!(
            only(&totals),
            Tokens {
                input: 5,
                output: 9,
                cache_read: 3,
                cache_write: 2
            }
        );
        assert!(totals.contains_key(&("2026-10-30".to_owned(), "opus".to_owned())));
    }

    #[test]
    fn codex_skips_repeated_totals_and_moves_cached_input_out() {
        let event = |total: u64| {
            format!(
                r#"{{"timestamp":"2026-10-30T02:00:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"total_tokens":{total}}},"last_token_usage":{{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}}}}}}}"#
            )
        };
        let context = r#"{"type":"turn_context","payload":{"model":"gpt-x"}}"#;
        let empty = r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#;
        let (a, b) = (event(107), event(214));
        let totals = scan_codex(lines(&[context, empty, &a, &a, &b]));
        assert_eq!(
            only(&totals),
            Tokens {
                input: 120,
                output: 14,
                cache_read: 80,
                cache_write: 0
            }
        );
        assert!(totals.contains_key(&("2026-10-30".to_owned(), "gpt-x".to_owned())));
    }

    #[test]
    fn prices_follow_aliases_and_an_unpriced_model_has_no_cost() {
        let mut settings = crate::store::default_settings();
        settings.model_prices = vec![ModelPrice {
            model: "base".into(),
            input: 2.0,
            output: 10.0,
            cache_read: 1.0,
            cache_write: 0.0,
        }];
        settings.model_aliases = vec![ModelAlias {
            model: "base-2026".into(),
            counts_as: "base".into(),
        }];
        let mut totals = FileTotals::new();
        let tokens = Tokens {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 1_000_000,
            cache_write: 0,
        };
        totals.insert(("d".into(), "base-2026".into()), tokens);
        totals.insert(("d".into(), "mystery".into()), tokens);
        let usage = summarize("x", ("scanned".into(), 1, 0, totals), &settings);
        assert_eq!(usage.models[0].model, "base");
        assert_eq!(usage.models[0].estimated_cost, Some(13.0));
        assert_eq!(usage.models[1].estimated_cost, None);
        assert_eq!(usage.days[0].tokens, 6_000_000);
    }

    #[test]
    fn only_jsonl_files_are_considered() {
        let dir = crate::testing::TempDir::new();
        let nested = dir.path().join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("s.jsonl"), "").unwrap();
        std::fs::write(nested.join("auth.json"), "").unwrap();
        std::fs::write(nested.join(".credentials.json"), "").unwrap();
        let mut found = Vec::new();
        jsonl_files(dir.path(), &mut found);
        assert_eq!(found, [nested.join("s.jsonl")]);
    }

    #[test]
    fn the_host_id_is_stable() {
        let dir = crate::testing::TempDir::new();
        let first = UsageCenter::new(dir.path()).unwrap().host_id;
        assert_eq!(UsageCenter::new(dir.path()).unwrap().host_id, first);
    }
}
