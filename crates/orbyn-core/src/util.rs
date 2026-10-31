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
    fn tail_keeps_character_boundaries() {
        assert_eq!(tail("ééé", 3), "é");
    }
}
