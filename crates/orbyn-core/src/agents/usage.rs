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
    DailyUsage, EngineLimits, EngineUsage, LimitWindow, LimitsOverview, LimitsUnavailable,
    ModelPrice, ModelUsage, PooledWindow, ServerSettings, TierUsage, TokenCosts, UsageReport,
};
use serde_json::Value;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::util::{new_id, now, parse_time, write_private};

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

/// `(day, model, tier) -> tokens` for one file.
type FileTotals = BTreeMap<(String, String, String), Tokens>;

pub const STANDARD_TIER: &str = "standard";

/// The tiers history names. Anything else is counted as `other`, never dropped.
fn tier_of(name: Option<&str>) -> String {
    match name.map(str::trim).filter(|name| !name.is_empty()) {
        None => STANDARD_TIER.to_owned(),
        Some(name @ ("standard" | "fast" | "priority" | "batch" | "flex")) => name.to_owned(),
        Some("default" | "auto") => STANDARD_TIER.to_owned(),
        Some(_) => "other".to_owned(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Engine {
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
/// message stands. Input and cache counts are already separate. Fast mode is
/// `speed: fast`; otherwise the `service_tier` names the tier.
pub fn scan_claude(reader: impl BufRead) -> FileTotals {
    let mut messages: HashMap<String, (String, String, String, Tokens)> = HashMap::new();
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
        let tier = if usage.get("speed").and_then(Value::as_str) == Some("fast") {
            "fast".to_owned()
        } else {
            tier_of(usage.get("service_tier").and_then(Value::as_str))
        };
        messages.insert(
            id.to_owned(),
            (
                day_of(&entry),
                model,
                tier,
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
    for (day, model, tier, tokens) in messages.into_values() {
        totals.entry((day, model, tier)).or_default().add(tokens);
    }
    totals
}

/// Codex logs a running total with each turn, and repeats it unchanged. Its input
/// count includes cached input, so that part is moved out. A turn context's
/// `service_tier` names the tier of the turns after it.
pub fn scan_codex(reader: impl BufRead) -> FileTotals {
    let mut totals = FileTotals::new();
    let mut model = "unknown".to_owned();
    let mut tier = STANDARD_TIER.to_owned();
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
            tier = tier_of(payload.get("service_tier").and_then(Value::as_str));
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
            .entry((day_of(&entry), model.clone(), tier.clone()))
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

pub(crate) fn history_root(engine: Engine) -> Option<PathBuf> {
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

fn cost_split(tokens: Tokens, price: &ModelPrice) -> TokenCosts {
    let rate = |count: u64, per_million: f64| count as f64 / 1_000_000.0 * per_million;
    TokenCosts {
        input: rate(tokens.input, price.input),
        output: rate(tokens.output, price.output),
        cache_read: rate(tokens.cache_read, price.cache_read),
        cache_write: rate(tokens.cache_write, price.cache_write),
    }
}

fn split_total(costs: &TokenCosts) -> f64 {
    costs.input + costs.output + costs.cache_read + costs.cache_write
}

/// A tier's own rate, or the model's standard rate for the standard tier. Another
/// tier never borrows the standard rate, since engines bill those differently.
fn price_for<'a>(settings: &'a ServerSettings, model: &str, tier: &str) -> Option<&'a ModelPrice> {
    let tier_of_price =
        |price: &ModelPrice| price.tier.as_deref().unwrap_or(STANDARD_TIER).to_owned();
    settings
        .model_prices
        .iter()
        .find(|price| price.model == model && tier_of_price(price) == tier)
}

/// One day's tokens and the priced part of their cost.
#[derive(Clone, Copy, Default)]
struct Day {
    tokens: u64,
    cost: Option<f64>,
}

impl Day {
    fn add(&mut self, tokens: Tokens, cost: Option<f64>) {
        self.tokens += tokens.total();
        if let Some(cost) = cost {
            self.cost = Some(self.cost.unwrap_or(0.0) + cost);
        }
    }
}

fn daily(days: BTreeMap<String, Day>) -> Vec<DailyUsage> {
    days.into_iter()
        .map(|(date, day)| DailyUsage {
            date,
            tokens: day.tokens,
            estimated_cost: day.cost,
        })
        .collect()
}

fn model_usage(
    model: String,
    tiers: BTreeMap<String, Tokens>,
    days: BTreeMap<String, Day>,
    settings: &ServerSettings,
) -> ModelUsage {
    let mut tokens = Tokens::default();
    let mut split: Option<TokenCosts> = None;
    let mut unpriced = 0;
    let tiers = tiers
        .into_iter()
        .map(|(tier, counted)| {
            tokens.add(counted);
            let costs = price_for(settings, &model, &tier).map(|price| cost_split(counted, price));
            match &costs {
                Some(costs) => {
                    let sum = split.get_or_insert(TokenCosts {
                        input: 0.0,
                        output: 0.0,
                        cache_read: 0.0,
                        cache_write: 0.0,
                    });
                    sum.input += costs.input;
                    sum.output += costs.output;
                    sum.cache_read += costs.cache_read;
                    sum.cache_write += costs.cache_write;
                }
                None => unpriced += counted.total(),
            }
            TierUsage {
                tier,
                tokens: counted.total(),
                estimated_cost: costs.as_ref().map(split_total),
            }
        })
        .collect();
    ModelUsage {
        estimated_cost: split.as_ref().map(split_total),
        cost_split: split,
        tiers,
        unpriced_tokens: unpriced,
        days: daily(days),
        model,
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_read_tokens: tokens.cache_read,
        cache_write_tokens: tokens.cache_write,
    }
}

/// `YYYY-MM-DD` of the first day inside a period of `days`, today included.
fn period_start(days: u32) -> String {
    let today = time::OffsetDateTime::now_utc().date();
    (today - time::Duration::days(i64::from(days.max(1)) - 1)).to_string()
}

fn summarize(
    engine: &str,
    (status, scanned, skipped, totals): (String, u32, u32, FileTotals),
    settings: &ServerSettings,
    since: Option<&str>,
) -> EngineUsage {
    let resolve = |model: &str| {
        settings
            .model_aliases
            .iter()
            .find(|alias| alias.model == model)
            .map_or_else(|| model.to_owned(), |alias| alias.counts_as.clone())
    };
    let mut models: BTreeMap<String, BTreeMap<String, Tokens>> = BTreeMap::new();
    let mut model_days: BTreeMap<String, BTreeMap<String, Day>> = BTreeMap::new();
    let mut days: BTreeMap<String, Day> = BTreeMap::new();
    for ((day, model, tier), tokens) in totals {
        if since.is_some_and(|since| day.as_str() < since) {
            continue;
        }
        let model = resolve(&model);
        let cost =
            price_for(settings, &model, &tier).map(|price| split_total(&cost_split(tokens, price)));
        model_days
            .entry(model.clone())
            .or_default()
            .entry(day.clone())
            .or_default()
            .add(tokens, cost);
        models
            .entry(model)
            .or_default()
            .entry(tier)
            .or_default()
            .add(tokens);
        days.entry(day).or_default().add(tokens, cost);
    }
    EngineUsage {
        engine: engine.to_owned(),
        status,
        files_scanned: scanned,
        files_skipped: skipped,
        models: models
            .into_iter()
            .map(|(model, tiers)| {
                let days = model_days.remove(&model).unwrap_or_default();
                model_usage(model, tiers, days, settings)
            })
            .collect(),
        days: daily(days),
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
    pub async fn report(
        &self,
        settings: &ServerSettings,
        days: Option<u32>,
    ) -> Result<UsageReport> {
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
        let since = days.map(period_start);
        Ok(UsageReport {
            host_id: self.host_id.clone(),
            scanned_at: now(),
            engines: scans
                .into_iter()
                .map(|(name, scan)| summarize(name, scan, settings, since.as_deref()))
                .collect(),
        })
    }

    /// Forgets every scan and limit, so the next read goes back to the sources.
    pub fn forget(&self) {
        *self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = ScanCache::default();
        self.limits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    fn cached_limits(&self, id: &str) -> Option<EngineLimits> {
        self.limits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .filter(|(at, _)| at.elapsed() < LIMITS_TTL)
            .map(|(_, limits)| limits.clone())
    }

    pub(crate) fn keep_limits(&self, limits: &EngineLimits) {
        self.limits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(limits.engine.clone(), (Instant::now(), limits.clone()));
    }
}

impl Core {
    /// An engine's own limit report, at most once per five minutes.
    /// Answers from a five-minute cache unless `force`, so opening a thread does
    /// not start an app-server each time. A forced read still spends no model usage.
    pub async fn engine_limits(&self, id: &str, force: bool) -> Result<EngineLimits> {
        if !force && let Some(cached) = self.usage.cached_limits(id) {
            return Ok(cached);
        }
        let report = self.engines.driver(id)?.limits().await?.ok_or_else(|| {
            CoreError::Unsupported("This engine does not report its limits.".into())
        })?;
        let limits = EngineLimits {
            engine: id.to_owned(),
            checked_at: now(),
            windows: limit_windows(&report),
            plan: report
                .get("planType")
                .and_then(Value::as_str)
                .map(str::to_owned),
            limits: report,
        };
        self.usage.keep_limits(&limits);
        Ok(limits)
    }

    /// Every engine's limits, and one number per window across them.
    pub async fn limits_overview(&self, force: bool) -> Result<LimitsOverview> {
        let mut engines = Vec::new();
        let mut unavailable = Vec::new();
        for status in self.engines.statuses(false).await? {
            if !status.installed {
                continue;
            }
            match self.engine_limits(&status.id, force).await {
                Ok(limits) => engines.push(limits),
                Err(CoreError::Unsupported(_)) => {}
                Err(error) => unavailable.push(LimitsUnavailable {
                    engine: status.id,
                    reason: error.public_message(),
                }),
            }
        }
        Ok(LimitsOverview {
            pooled: pool_windows(&engines),
            engines,
            unavailable,
        })
    }
}

/// Claude's driver supplies sanitized windows; Codex supplies a `rateLimits`
/// block with reset times as Unix seconds.
fn limit_windows(report: &Value) -> Vec<LimitWindow> {
    if let Some(windows) = report.get("windows") {
        return serde_json::from_value(windows.clone()).unwrap_or_default();
    }
    let Some(limits) = report.get("rateLimits") else {
        return Vec::new();
    };
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|id| {
            let window = limits.get(id)?;
            let minutes = window.get("windowDurationMins").and_then(Value::as_u64);
            Some(LimitWindow {
                id: id.to_owned(),
                label: window_label(minutes),
                used_percent: window.get("usedPercent")?.as_f64()?,
                window_minutes: minutes,
                resets_at: window
                    .get("resetsAt")
                    .and_then(Value::as_i64)
                    .and_then(rfc3339),
            })
        })
        .collect()
}

fn rfc3339(unix: i64) -> Option<String> {
    let at = time::OffsetDateTime::from_unix_timestamp(unix).ok()?;
    at.format(&time::format_description::well_known::Rfc3339)
        .ok()
}

fn window_label(minutes: Option<u64>) -> String {
    match minutes {
        Some(minutes) if minutes % 1440 == 0 && minutes >= 1440 => {
            format!("{} days", minutes / 1440)
        }
        Some(minutes) if minutes % 60 == 0 && minutes >= 60 => format!("{} hours", minutes / 60),
        Some(minutes) => format!("{minutes} minutes"),
        None => "Window".to_owned(),
    }
}

fn pool_windows(engines: &[EngineLimits]) -> Vec<PooledWindow> {
    let mut pooled: Vec<PooledWindow> = Vec::new();
    for engine in engines {
        for window in &engine.windows {
            let slot = pooled.iter().position(|known| {
                window.window_minutes.is_some() && known.window_minutes == window.window_minutes
            });
            let slot = slot.unwrap_or_else(|| {
                pooled.push(PooledWindow {
                    label: window.label.clone(),
                    window_minutes: window.window_minutes,
                    used_percent: 0.0,
                    resets_at: None,
                    engines: Vec::new(),
                });
                pooled.len() - 1
            });
            let entry = &mut pooled[slot];
            entry.used_percent = entry.used_percent.max(window.used_percent);
            if !entry.engines.contains(&engine.engine) {
                entry.engines.push(engine.engine.clone());
            }
            entry.resets_at = match (entry.resets_at.take(), &window.resets_at) {
                (Some(known), Some(new)) => Some(if parse_time(new) < parse_time(&known) {
                    new.clone()
                } else {
                    known
                }),
                (known, new) => known.or_else(|| new.clone()),
            };
        }
    }
    pooled.sort_by_key(|window| window.window_minutes);
    pooled
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbyn_contracts::ModelAlias;
    use serde_json::json;

    fn lines(items: &[&str]) -> std::io::Cursor<Vec<u8>> {
        std::io::Cursor::new(items.join("\n").into_bytes())
    }

    fn only(totals: &FileTotals) -> Tokens {
        assert_eq!(totals.len(), 1, "{totals:?}");
        *totals.values().next().unwrap()
    }

    #[test]
    fn windows_pool_by_length_and_keep_the_worst_number() {
        let report = |percent: f64, resets: i64| {
            json!({ "rateLimits": { "primary": {
                "usedPercent": percent, "windowDurationMins": 300, "resetsAt": resets,
            }}})
        };
        let limits = |engine: &str, report: Value| EngineLimits {
            engine: engine.into(),
            checked_at: String::new(),
            windows: limit_windows(&report),
            plan: None,
            limits: report,
        };
        let pooled = pool_windows(&[
            limits("a", report(10.0, 2_000_000_000)),
            limits("b", report(60.0, 1_900_000_000)),
        ]);
        assert_eq!(pooled.len(), 1);
        assert_eq!(pooled[0].label, "5 hours");
        assert_eq!(pooled[0].used_percent, 60.0);
        assert_eq!(pooled[0].engines, ["a", "b"]);
        assert_eq!(
            parse_time(pooled[0].resets_at.as_ref().unwrap()),
            Some(1_900_000_000)
        );
        assert!(limit_windows(&json!({ "other": 1 })).is_empty());
    }

    #[test]
    fn scoped_windows_keep_one_engine_in_a_shared_pool() {
        let report = json!({ "windows": [
            { "id": "seven_day", "label": "Weekly", "used_percent": 20.0, "window_minutes": 10080, "resets_at": null },
            { "id": "model:Example", "label": "Weekly · Example", "used_percent": 70.0, "window_minutes": 10080, "resets_at": null }
        ] });
        let pooled = pool_windows(&[EngineLimits {
            engine: "claude".into(),
            checked_at: String::new(),
            windows: limit_windows(&report),
            plan: None,
            limits: report,
        }]);
        assert_eq!(pooled.len(), 1);
        assert_eq!(pooled[0].used_percent, 70.0);
        assert_eq!(pooled[0].engines, ["claude"]);
        assert!(pooled[0].resets_at.is_none());
    }

    #[test]
    fn unknown_lengths_do_not_pool_unrelated_windows() {
        let engine = |id: &str, labels: &[&str]| EngineLimits {
            engine: id.into(),
            checked_at: String::new(),
            plan: None,
            limits: Value::Null,
            windows: labels
                .iter()
                .enumerate()
                .map(|(index, label)| LimitWindow {
                    id: index.to_string(),
                    label: (*label).into(),
                    used_percent: 20.0,
                    window_minutes: None,
                    resets_at: None,
                })
                .collect(),
        };
        let pooled = pool_windows(&[
            engine("codex", &["Window"]),
            engine("claude", &["Monthly spend"]),
        ]);
        assert_eq!(pooled.len(), 2);
        assert_eq!(pooled[0].label, "Window");
        assert_eq!(pooled[0].engines, ["codex"]);
        assert_eq!(pooled[1].label, "Monthly spend");
        assert_eq!(pooled[1].engines, ["claude"]);

        let pooled = pool_windows(&[engine("claude", &["Window", "Window"])]);
        assert_eq!(
            pooled.len(),
            2,
            "a shared label does not establish a shared budget"
        );
        assert!(
            pooled
                .iter()
                .all(|window| window.window_minutes.is_none() && window.engines == ["claude"])
        );
    }

    #[test]
    fn a_period_keeps_only_its_days() {
        let mut totals = FileTotals::new();
        let tokens = Tokens {
            input: 5,
            ..Tokens::default()
        };
        totals.insert(
            ("2000-01-01".into(), "m".into(), STANDARD_TIER.into()),
            tokens,
        );
        totals.insert((period_start(1), "m".into(), STANDARD_TIER.into()), tokens);
        let settings = crate::store::default_settings();
        let scan = ("scanned".to_owned(), 1, 0, totals);
        let usage = summarize("claude", scan.clone(), &settings, Some(&period_start(7)));
        assert_eq!(usage.days.len(), 1);
        assert_eq!(usage.models[0].input_tokens, 5);
        assert_eq!(
            summarize("claude", scan, &settings, None).models[0].input_tokens,
            10
        );
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
        assert!(totals.contains_key(&(
            "2026-10-30".to_owned(),
            "opus".to_owned(),
            "standard".to_owned()
        )));
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
        assert!(totals.contains_key(&(
            "2026-10-30".to_owned(),
            "gpt-x".to_owned(),
            "standard".to_owned()
        )));
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
            tier: None,
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
        totals.insert(
            ("d".into(), "base-2026".into(), STANDARD_TIER.into()),
            tokens,
        );
        totals.insert(("d".into(), "mystery".into(), STANDARD_TIER.into()), tokens);
        let usage = summarize("x", ("scanned".into(), 1, 0, totals), &settings, None);
        assert_eq!(usage.models[0].model, "base");
        assert_eq!(usage.models[0].estimated_cost, Some(13.0));
        assert_eq!(usage.models[1].estimated_cost, None);
        assert_eq!(usage.days[0].tokens, 6_000_000);
        assert_eq!(
            usage.models[0].days.len(),
            1,
            "each model keeps its own trend"
        );
        assert_eq!(usage.models[0].days[0].tokens, 3_000_000);
        assert_eq!(
            usage.days[0].estimated_cost,
            Some(13.0),
            "the priced part of the day"
        );
        assert_eq!(usage.models[1].days[0].estimated_cost, None);
    }

    #[test]
    fn tiers_come_from_history_and_are_priced_only_by_their_own_rate() {
        let claude = scan_claude(lines(&[
            r#"{"timestamp":"2026-10-30T01:00:00Z","message":{"id":"a","model":"m","usage":{"input_tokens":10,"speed":"standard","service_tier":"standard"}}}"#,
            r#"{"timestamp":"2026-10-30T01:00:00Z","message":{"id":"b","model":"m","usage":{"input_tokens":20,"speed":"fast","service_tier":"standard"}}}"#,
            r#"{"timestamp":"2026-10-30T01:00:00Z","message":{"id":"c","model":"m","usage":{"input_tokens":30,"service_tier":"priority"}}}"#,
            r#"{"timestamp":"2026-10-30T01:00:00Z","message":{"id":"d","model":"m","usage":{"input_tokens":40,"service_tier":"mystery"}}}"#,
        ]));
        let tiers: Vec<&str> = claude.keys().map(|(_, _, tier)| tier.as_str()).collect();
        assert_eq!(tiers, ["fast", "other", "priority", "standard"]);

        let codex = scan_codex(lines(&[
            r#"{"type":"turn_context","payload":{"model":"g","service_tier":"fast"}}"#,
            r#"{"timestamp":"2026-10-30T02:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":5},"last_token_usage":{"input_tokens":5}}}}"#,
        ]));
        assert!(codex.contains_key(&("2026-10-30".into(), "g".into(), "fast".into())));

        let mut settings = crate::store::default_settings();
        let price = |tier: Option<&str>, input: f64| ModelPrice {
            model: "m".into(),
            input,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            tier: tier.map(str::to_owned),
        };
        let million = |input: u64| Tokens {
            input: input * 1_000_000,
            output: 1_000_000,
            ..Tokens::default()
        };
        settings.model_prices = vec![price(None, 1.0), price(Some("fast"), 6.0)];
        let mut tiers = BTreeMap::new();
        tiers.insert("standard".to_owned(), million(1));
        tiers.insert("fast".to_owned(), million(2));
        tiers.insert("priority".to_owned(), million(3));
        let usage = model_usage("m".into(), tiers, BTreeMap::new(), &settings);
        assert_eq!(usage.estimated_cost, Some(13.0));
        let split = usage.cost_split.unwrap();
        assert_eq!((split.input, split.output), (13.0, 0.0));
        assert_eq!(
            usage.unpriced_tokens, 4_000_000,
            "priority has no rate of its own"
        );
        let priority = usage
            .tiers
            .iter()
            .find(|tier| tier.tier == "priority")
            .unwrap();
        assert_eq!(priority.estimated_cost, None);
        assert_eq!(
            usage
                .tiers
                .iter()
                .find(|tier| tier.tier == "fast")
                .unwrap()
                .estimated_cost,
            Some(12.0)
        );
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
