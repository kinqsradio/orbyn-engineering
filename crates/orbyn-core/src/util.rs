//! Small shared primitives: ids, timestamps, random tokens, hex and owner-only files.

use std::path::Path;

use crate::error::{CoreError, Result};
use sha2::{Digest, Sha256};

pub fn new_id() -> String {
    ulid::Ulid::new().to_string().to_lowercase()
}

pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

/// Unix seconds for an RFC 3339 time.
pub fn parse_time(text: &str) -> Option<i64> {
    time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(time::OffsetDateTime::unix_timestamp)
}

pub fn unix_now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|error| CoreError::Internal(format!("system randomness failed: {error}")))?;
    Ok(bytes)
}

/// A 256-bit random value as lowercase hex.
pub fn random_token() -> Result<String> {
    Ok(hex(&random_bytes::<32>()?))
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(text.get(index..index + 2)?, 16).ok())
        .collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Compares through digests so the comparison leaks nothing about the secret.
pub fn secrets_match(presented: &str, expected_sha256_hex: &str) -> bool {
    let presented = Sha256::digest(presented.as_bytes());
    let Some(expected) = from_hex(expected_sha256_hex) else {
        return false;
    };
    if expected.len() != presented.len() {
        return false;
    }
    presented
        .iter()
        .zip(expected.iter())
        .fold(0u8, |diff, (left, right)| diff | (left ^ right))
        == 0
}

/// Writes a file readable only by the current user.
///
/// On Unix the mode is set at creation. Windows has no mode bits: the file
/// inherits the ACL of the per-user app-data directory, which already excludes
/// other non-administrator users (see docs/architecture.md, Persistence).
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Resolves a path for use with other programs. Windows canonical paths carry a
/// `\\?\` prefix that many tools, Git and Node among them, cannot read.
pub fn canonicalize(path: &Path) -> std::io::Result<std::path::PathBuf> {
    let resolved = std::fs::canonicalize(path)?;
    Ok(strip_verbatim(&resolved.to_string_lossy()).into())
}

/// Drops the verbatim prefix unless that would change what the path names: without
/// it Windows reads `CON` as a device, trims trailing dots and limits the length.
fn strip_verbatim(path: &str) -> String {
    let (plain, tail) = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        (format!(r"\\{rest}"), rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        (rest.to_owned(), rest)
    } else {
        return path.to_owned();
    };
    let kept = tail.split('\\').all(|part| !needs_verbatim(part));
    if kept && plain.len() < MAX_PLAIN_PATH {
        plain
    } else {
        path.to_owned()
    }
}

/// `MAX_PATH`, leaving room for the terminator.
const MAX_PLAIN_PATH: usize = 260;

fn needs_verbatim(part: &str) -> bool {
    if part.ends_with(['.', ' ']) && part != "." && part != ".." {
        return true;
    }
    let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix).is_some_and(|rest| {
            matches!(
                rest,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    };
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered("COM") || numbered("LPT")
}

/// Keeps the tail of diagnostic output that is safe to bound.
pub fn tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.trim().to_owned();
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_verbatim_prefix_goes_only_when_the_path_means_the_same_without_it() {
        assert_eq!(strip_verbatim(r"\\?\C:\work\app"), r"C:\work\app");
        assert_eq!(strip_verbatim(r"\\?\UNC\host\share\a"), r"\\host\share\a");
        assert_eq!(strip_verbatim(r"/already/plain"), r"/already/plain");
        for kept in [
            r"\\?\C:\work\CON",
            r"\\?\C:\work\nul.txt",
            r"\\?\C:\work\COM1\x",
            r"\\?\C:\work\LPT²",
            r"\\?\C:\work\name.",
            r"\\?\C:\work\name ",
        ] {
            assert_eq!(strip_verbatim(kept), kept);
        }
        let long = format!(r"\\?\C:\{}", "a".repeat(300));
        assert_eq!(strip_verbatim(&long), long);
        assert_eq!(
            strip_verbatim(r"\\?\C:\console\company"),
            r"C:\console\company"
        );
    }

    #[test]
    fn hex_round_trips_and_rejects_odd_input() {
        assert_eq!(from_hex(&hex(&[0, 171, 255])).unwrap(), vec![0, 171, 255]);
        assert!(from_hex("abc").is_none());
        assert!(from_hex("zz").is_none());
    }

    #[test]
    fn secret_comparison_needs_the_exact_value() {
        let expected = sha256_hex(b"secret");
        assert!(secrets_match("secret", &expected));
        assert!(!secrets_match("secreT", &expected));
        assert!(!secrets_match("secret", "not hex"));
    }

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(strip_verbatim(r"\\?\C:\repo"), r"C:\repo");
        assert_eq!(strip_verbatim(r"\\?\UNC\host\share"), r"\\host\share");
        assert_eq!(strip_verbatim("/usr/bin"), "/usr/bin");
    }

    #[test]
    fn tail_keeps_character_boundaries() {
        assert_eq!(tail("ééé", 3), "é");
    }
}
