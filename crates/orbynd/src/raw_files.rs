//! `GET /api/threads/:id/files/raw`: a file's bytes over HTTP, with byte ranges so a
//! video can seek and a large PDF or binary view can read pieces. What may be read and
//! which types are shown inline are decided in core; this file is the HTTP around it.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use orbyn_core::file_bytes::RawFile;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::api::{ApiResult, AppState};

/// Stops anything a file holds from running, even opened directly in a tab.
const SANDBOX: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

#[derive(Debug, PartialEq, Eq)]
enum Wanted {
    Whole,
    Part { start: u64, end: u64 },
    Unsatisfiable,
}

/// Digits only. One too long for a `u64` is still a number, just past any file.
fn position(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(text.parse().unwrap_or(u64::MAX))
}

/// Reads a `Range` header. A form this doesn't serve, including several ranges at
/// once, is ignored, as the HTTP spec allows, and the whole file is sent.
fn parse_range(header: Option<&str>, size: u64) -> Wanted {
    let Some(spec) = header.and_then(|text| {
        let (unit, spec) = text.trim().split_once('=')?;
        unit.eq_ignore_ascii_case("bytes").then_some(spec)
    }) else {
        return Wanted::Whole;
    };
    let Some((from, to)) = spec.split_once('-') else {
        return Wanted::Whole;
    };
    if from.is_empty() {
        return match position(to) {
            None => Wanted::Whole,
            Some(0) => Wanted::Unsatisfiable,
            Some(_) if size == 0 => Wanted::Unsatisfiable,
            Some(tail) => Wanted::Part {
                start: size.saturating_sub(tail),
                end: size - 1,
            },
        };
    }
    let Some(start) = position(from) else {
        return Wanted::Whole;
    };
    let end = if to.is_empty() {
        u64::MAX
    } else {
        match position(to) {
            Some(end) if end >= start => end,
            _ => return Wanted::Whole,
        }
    };
    if start >= size {
        return Wanted::Unsatisfiable;
    }
    Wanted::Part {
        start,
        end: end.min(size - 1),
    }
}

/// A name for `Content-Disposition`, percent-encoded so nothing in it can break out
/// of the header.
fn encoded_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b".-_~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// Lists one exact tag or `*`. Weak forms never match, since a range needs exact bytes.
fn tag_listed(list: &str, tag: &str) -> bool {
    list.split(',')
        .map(str::trim)
        .any(|item| item == tag || item == "*")
}

fn common_headers(raw: &RawFile) -> ApiResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    let disposition = if raw.inline { "inline" } else { "attachment" };
    let disposition = format!(
        "{disposition}; filename*=UTF-8''{}",
        encoded_name(&raw.name)
    );
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(raw.content_type),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .map_err(|_| orbyn_core::CoreError::Invalid("That name cannot be sent.".into()))?,
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&raw.tag)
            .map_err(|_| orbyn_core::CoreError::Internal("A bad file tag.".into()))?,
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    if raw.sandbox {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(SANDBOX),
        );
    }
    Ok(headers)
}

#[derive(Deserialize)]
pub struct RawQuery {
    path: String,
    #[serde(default)]
    download: bool,
}

pub async fn serve(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<RawQuery>,
    request: HeaderMap,
) -> ApiResult<Response> {
    let raw = state.core.open_raw_file(&id, &query.path, query.download)?;
    let mut headers = common_headers(&raw)?;
    if header_text(&request, header::IF_NONE_MATCH).is_some_and(|list| tag_listed(list, &raw.tag)) {
        return Ok((StatusCode::NOT_MODIFIED, headers).into_response());
    }
    // A range of a file that changed would stitch two versions together.
    let current = header_text(&request, header::IF_RANGE).is_none_or(|tag| tag == raw.tag);
    let range = current
        .then(|| header_text(&request, header::RANGE))
        .flatten();
    let size = raw.size;
    let (status, start, length) = match parse_range(range, size) {
        Wanted::Whole => (StatusCode::OK, 0, size),
        Wanted::Part { start, end } => {
            let content_range = format!("bytes {start}-{end}/{size}");
            headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&content_range)
                    .map_err(|_| orbyn_core::CoreError::Internal("A bad range.".into()))?,
            );
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        Wanted::Unsatisfiable => {
            let content_range = format!("bytes */{size}");
            headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&content_range)
                    .map_err(|_| orbyn_core::CoreError::Internal("A bad range.".into()))?,
            );
            headers.remove(header::CONTENT_DISPOSITION);
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response());
        }
    };
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    let mut file = tokio::fs::File::from_std(raw.file);
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(orbyn_core::CoreError::from)?;
    let body = Body::from_stream(ReaderStream::new(file.take(length)));
    Ok((status, headers, body).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(start: u64, end: u64) -> Wanted {
        Wanted::Part { start, end }
    }

    #[test]
    fn ranges_cover_each_form_and_stop_at_the_end() {
        assert_eq!(parse_range(Some("bytes=0-9"), 100), part(0, 9));
        assert_eq!(parse_range(Some("BYTES=90-"), 100), part(90, 99));
        assert_eq!(parse_range(Some("bytes=90-5000"), 100), part(90, 99));
        assert_eq!(parse_range(Some("bytes=-10"), 100), part(90, 99));
        assert_eq!(parse_range(Some("bytes=-5000"), 100), part(0, 99));
        assert_eq!(parse_range(Some("bytes=5-5"), 100), part(5, 5));
    }

    #[test]
    fn ranges_past_the_end_are_refused_and_bad_ones_are_ignored() {
        for bad in [
            "bytes=100-",
            "bytes=500-600",
            "bytes=-0",
            "bytes=99999999999999999999999-",
        ] {
            assert_eq!(parse_range(Some(bad), 100), Wanted::Unsatisfiable, "{bad}");
        }
        assert_eq!(parse_range(Some("bytes=-1"), 0), Wanted::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), Wanted::Unsatisfiable);
        for ignored in [
            "items=0-1",
            "bytes=",
            "bytes=-",
            "bytes=9-3",
            "bytes=a-b",
            "bytes=0-1,5-6",
            "bytes=0-1-2",
            "bytes=+1-2",
        ] {
            assert_eq!(parse_range(Some(ignored), 100), Wanted::Whole, "{ignored}");
        }
        assert_eq!(parse_range(None, 100), Wanted::Whole);
    }

    #[test]
    fn a_name_cannot_break_out_of_its_header() {
        assert_eq!(encoded_name("a b\r\n\"x\".png"), "a%20b%0D%0A%22x%22.png");
        assert_eq!(encoded_name("图.png"), "%E5%9B%BE.png");
    }
}
