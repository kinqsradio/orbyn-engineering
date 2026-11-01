//! Presentation of the Core's local timing report; no service connection.
use std::path::Path;
use std::time::Duration;

fn date(ms: u64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|date| {
            date.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

pub fn duration(text: &str) -> Result<Duration, String> {
    let text = text.trim();
    let split = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let value = text[..split]
        .parse::<u64>()
        .map_err(|_| "Use a duration such as 30m or 2h.".to_owned())?;
    let multiplier = match text[split..].trim().to_ascii_lowercase().as_str() {
        "ms" | "millis" | "milliseconds" => 1,
        "s" | "seconds" => 1000,
        "m" | "minutes" => 60_000,
        "h" | "hours" => 3_600_000,
        "d" | "days" => 86_400_000,
        "w" | "weeks" => 604_800_000,
        _ => return Err("Use a duration such as 30m or 2h.".into()),
    };
    value
        .checked_mul(multiplier)
        .map(Duration::from_millis)
        .ok_or_else(|| "Choose a duration within range.".into())
}

pub fn summary(data: &Path, since: Option<Duration>, limit: u32, json: bool) -> Result<(), String> {
    let report =
        orbyn_core::local_trace::summarize(data, since).map_err(|error| error.to_string())?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
        );
    } else if report.span_count == 0 {
        println!(
            "No spans found in {} or its rotated files{}.",
            orbyn_core::local_trace::trace_path(data).display(),
            if since.is_some() {
                " in that window"
            } else {
                ""
            }
        );
        if report.skipped_lines > 0 {
            println!("Skipped {} lines that are not spans.", report.skipped_lines);
        }
    } else {
        println!(
            "{} spans ended from {} to {}.",
            report.span_count,
            date(report.first_end_ms.unwrap_or_default()),
            date(report.last_end_ms.unwrap_or_default())
        );
        if report.skipped_lines > 0 {
            println!("Skipped {} lines that are not spans.", report.skipped_lines);
        }
        println!("span\tcount\t/min\tp50\tp90\tmax\tinterrupted\tfailed");
        for row in report.spans.iter().take(limit as usize) {
            let rate = row
                .per_minute
                .map_or_else(|| "-".into(), |rate| format!("{rate:.1}"));
            println!(
                "{}\t{}\t{}\t{:.1}ms\t{:.1}ms\t{:.1}ms\t{}\t{}",
                row.name,
                row.count,
                rate,
                row.p50_ms,
                row.p90_ms,
                row.max_ms,
                row.interrupted,
                row.failed
            );
        }
        if report.spans.len() > limit as usize {
            println!(
                "{} more span names. Use --limit to show more.",
                report.spans.len() - limit as usize
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trace_windows_accept_the_documented_short_and_long_durations() {
        assert_eq!(duration("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(duration(" 15 minutes ").unwrap(), Duration::from_secs(900));
        assert_eq!(duration("1W").unwrap(), Duration::from_secs(7 * 86400));
        assert_eq!(duration("0s").unwrap(), Duration::ZERO);
        for value in ["", "bad", "-1h", "18446744073709551615d"] {
            assert!(duration(value).is_err());
        }
    }
}
