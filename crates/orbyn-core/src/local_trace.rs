//! Bounded, payload-free local operation timings and an offline summary reader.
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const BACKUPS: usize = 10;
const MAX_LINE: u64 = 16 * 1024;
const MAX_SCAN: u64 = 128 * 1024 * 1024;
const MAX_SPANS: usize = 1_000_000;
const MAX_NAMES: usize = 4096;

pub fn trace_path(data: &Path) -> PathBuf {
    data.join("logs/server.trace.ndjson")
}

fn backup(path: &Path, index: usize) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

struct Writer {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
    max_bytes: u64,
    backups: usize,
}

impl Writer {
    fn open(path: PathBuf, max_bytes: u64, backups: usize) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            path,
            file: Some(file),
            bytes,
            max_bytes,
            backups,
        })
    }

    fn append(&mut self, line: &[u8]) -> io::Result<()> {
        if self.bytes > 0 && self.bytes.saturating_add(line.len() as u64) > self.max_bytes {
            // Close before renaming, including on Windows. A later append can
            // reopen the active file if a previous rotation encountered an error.
            self.file.take();
            for index in (0..self.backups).rev() {
                let from = if index == 0 {
                    self.path.clone()
                } else {
                    backup(&self.path, index)
                };
                let to = backup(&self.path, index + 1);
                match std::fs::remove_file(&to) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                match std::fs::rename(from, to) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
            self.bytes = 0;
        }
        if self.file.is_none() {
            self.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?,
            );
            self.bytes = self.file.as_ref().expect("opened").metadata()?.len();
        }
        if let Err(error) = self.file.as_mut().expect("opened").write_all(line) {
            self.bytes = self.file.as_ref().expect("opened").metadata()?.len();
            return Err(error);
        }
        self.bytes = self.bytes.saturating_add(line.len() as u64);
        Ok(())
    }
}

pub struct LocalTrace(Mutex<Writer>);

impl LocalTrace {
    pub fn open(data: &Path) -> io::Result<Arc<Self>> {
        Ok(Arc::new(Self(Mutex::new(Writer::open(
            trace_path(data),
            MAX_BYTES,
            BACKUPS,
        )?))))
    }

    /// Names are registered operation labels, never URLs, paths, prompts or errors.
    pub fn span(self: &Arc<Self>, name: &str) -> TimingSpan {
        let name = if name.len() <= 160 && name.bytes().all(|b| b.is_ascii_graphic() || b == b' ') {
            name.to_owned()
        } else {
            "operation".to_owned()
        };
        TimingSpan {
            trace: self.clone(),
            name,
            started: Instant::now(),
            outcome: Outcome::Interrupted,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Serialize, Deserialize)]
struct SpanRecord {
    name: String,
    duration_ms: f64,
    end_time_unix_nano: String,
    outcome: Outcome,
}

pub struct TimingSpan {
    trace: Arc<LocalTrace>,
    name: String,
    started: Instant,
    outcome: Outcome,
}

impl TimingSpan {
    pub fn finish(mut self, success: bool) {
        self.outcome = if success {
            Outcome::Succeeded
        } else {
            Outcome::Failed
        };
    }
}

impl Drop for TimingSpan {
    fn drop(&mut self) {
        let record = SpanRecord {
            name: self.name.clone(),
            duration_ms: self.started.elapsed().as_secs_f64() * 1000.0,
            end_time_unix_nano: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_string(),
            outcome: self.outcome,
        };
        let Ok(mut line) = serde_json::to_vec(&record) else {
            return;
        };
        line.push(b'\n');
        let mut writer = self
            .trace
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if writer.append(&line).is_err() {
            // Do not include operation inputs, error strings or paths in a log.
            tracing::warn!("could not record local operation timing");
        }
    }
}

#[derive(Serialize)]
pub struct SpanSummary {
    pub name: String,
    pub count: usize,
    pub per_minute: Option<f64>,
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub max_ms: f64,
    pub interrupted: usize,
    pub failed: usize,
}

#[derive(Serialize)]
pub struct TraceSummary {
    pub span_count: usize,
    pub skipped_lines: usize,
    pub first_end_ms: Option<u64>,
    pub last_end_ms: Option<u64>,
    pub spans: Vec<SpanSummary>,
}

#[derive(Default)]
struct Samples {
    values: Vec<f64>,
    interrupted: usize,
    failed: usize,
}

/// Reads existing local files only; no service, engine or network is needed.
pub fn summarize(data: &Path, since: Option<Duration>) -> io::Result<TraceSummary> {
    let since_ms = since.map(|window| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .saturating_sub(window.as_millis())
    });
    let path = trace_path(data);
    let mut remaining = MAX_SCAN;
    let mut count = 0;
    let mut skipped = 0;
    let mut first: Option<u64> = None;
    let mut last: Option<u64> = None;
    let mut samples: BTreeMap<String, Samples> = BTreeMap::new();
    for path in (1..=BACKUPS)
        .rev()
        .map(|index| backup(&path, index))
        .chain([path.clone()])
    {
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let bytes = file.metadata()?.len();
        if bytes > remaining {
            return Err(io::Error::other("Trace files exceed the scan budget."));
        }
        remaining -= bytes;
        // Concurrent appends cannot extend this snapshot without a bound.
        let mut reader = BufReader::new(file.take(bytes));
        let mut line = Vec::new();
        loop {
            line.clear();
            if reader
                .by_ref()
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line)?
                == 0
            {
                break;
            }
            if line.len() as u64 > MAX_LINE {
                if !line.ends_with(b"\n") {
                    reader.skip_until(b'\n')?;
                }
                skipped += 1;
                continue;
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let record = serde_json::from_slice::<SpanRecord>(&line)
                .ok()
                .filter(|record| {
                    !record.name.is_empty()
                        && record.name.len() <= 160
                        && !record.name.chars().any(char::is_control)
                        && record.duration_ms.is_finite()
                        && record.duration_ms >= 0.0
                });
            let Some(record) = record else {
                skipped += 1;
                continue;
            };
            let Some(nanos) = record
                .end_time_unix_nano
                .parse::<i128>()
                .ok()
                .filter(|nanos| *nanos >= 0)
            else {
                skipped += 1;
                continue;
            };
            if time::OffsetDateTime::from_unix_timestamp_nanos(nanos).is_err() {
                skipped += 1;
                continue;
            }
            let end = (nanos / 1_000_000) as u64;
            if since_ms.is_some_and(|since| u128::from(end) < since) {
                continue;
            }
            if count >= MAX_SPANS
                || !samples.contains_key(&record.name) && samples.len() >= MAX_NAMES
            {
                return Err(io::Error::other("Trace summary exceeds the span budget."));
            }
            count += 1;
            first = Some(first.map_or(end, |old| old.min(end)));
            last = Some(last.map_or(end, |old| old.max(end)));
            let group = samples.entry(record.name).or_default();
            group.values.push(record.duration_ms);
            match record.outcome {
                Outcome::Failed => group.failed += 1,
                Outcome::Interrupted => group.interrupted += 1,
                Outcome::Succeeded => {}
            }
        }
    }
    let minutes = first
        .zip(last)
        .map_or(0.0, |(first, last)| (last - first) as f64 / 60_000.0);
    let mut spans = samples
        .into_iter()
        .map(|(name, mut group)| {
            group.values.sort_by(f64::total_cmp);
            let count = group.values.len();
            SpanSummary {
                name,
                count,
                per_minute: (minutes > 0.0).then_some(count as f64 / minutes),
                p50_ms: group.values[(count as f64 * 0.5).ceil() as usize - 1],
                p90_ms: group.values[(count as f64 * 0.9).ceil() as usize - 1],
                max_ms: group.values[count - 1],
                interrupted: group.interrupted,
                failed: group.failed,
            }
        })
        .collect::<Vec<_>>();
    spans.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then(left.name.cmp(&right.name))
    });
    Ok(TraceSummary {
        span_count: count,
        skipped_lines: skipped,
        first_end_ms: first,
        last_end_ms: last,
        spans,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn completed_failed_and_dropped_spans_have_bounded_records() {
        let dir = TempDir::new();
        let trace = LocalTrace::open(dir.path()).unwrap();
        trace.span("GET /api/info").finish(true);
        trace.span("POST /api/projects").finish(false);
        drop(trace.span("GET /api/workspace"));
        drop(trace);
        let report = summarize(dir.path(), None).unwrap();
        assert_eq!(report.span_count, 3);
        assert_eq!(report.spans.iter().map(|row| row.failed).sum::<usize>(), 1);
        assert_eq!(
            report
                .spans
                .iter()
                .map(|row| row.interrupted)
                .sum::<usize>(),
            1
        );
        let records = std::fs::read_to_string(trace_path(dir.path())).unwrap();
        for line in records.lines() {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 4);
            assert!(value.get("attributes").is_none());
        }
    }

    #[test]
    fn summaries_use_nearest_rank_and_skip_an_oversized_line_once() {
        let dir = TempDir::new();
        let mut writer = Writer::open(trace_path(dir.path()), MAX_BYTES, BACKUPS).unwrap();
        writer.append(&vec![b'x'; MAX_LINE as usize + 23]).unwrap();
        writer.append(b"\n\nnot-json\n").unwrap();
        for index in 1..=10 {
            let record = SpanRecord {
                name: "operation".into(),
                duration_ms: f64::from(index),
                end_time_unix_nano: (i128::from(index) * 60_000_000_000).to_string(),
                outcome: Outcome::Succeeded,
            };
            let mut line = serde_json::to_vec(&record).unwrap();
            line.push(b'\n');
            writer.append(&line).unwrap();
        }
        drop(writer);
        let report = summarize(dir.path(), None).unwrap();
        assert_eq!(report.span_count, 10);
        assert_eq!(report.skipped_lines, 2);
        let row = &report.spans[0];
        assert_eq!((row.p50_ms, row.p90_ms, row.max_ms), (5.0, 9.0, 10.0));
        assert_eq!(row.per_minute, Some(10.0 / 9.0));
        assert_eq!(
            summarize(dir.path(), Some(Duration::from_secs(60)))
                .unwrap()
                .span_count,
            0
        );
    }

    #[test]
    fn rotation_closes_files_and_keeps_only_the_configured_backups() {
        let dir = TempDir::new();
        let path = trace_path(dir.path());
        let mut writer = Writer::open(path.clone(), 8, 2).unwrap();
        for index in 0..5 {
            writer.append(format!("line-{index}\n").as_bytes()).unwrap();
        }
        drop(writer);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "line-4\n");
        assert_eq!(
            std::fs::read_to_string(backup(&path, 1)).unwrap(),
            "line-3\n"
        );
        assert_eq!(
            std::fs::read_to_string(backup(&path, 2)).unwrap(),
            "line-2\n"
        );
        assert!(!backup(&path, 3).exists());
    }
}
