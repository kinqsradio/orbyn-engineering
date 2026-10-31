//! The signed list of engine versions Orbyn has tested. The default ships inside
//! the binary with its detached ed25519 signature; a bad signature yields
//! `Unknown`, never a claim of support.

use std::collections::HashMap;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use orbyn_contracts::VersionSupport;
use serde::Deserialize;

use crate::util::from_hex;

const MANIFEST: &[u8] = include_bytes!("tested-versions.json");
const SIGNATURE: &str = include_str!("tested-versions.sig");
const PUBLIC_KEY: &str = include_str!("tested-versions.pub");

#[derive(Debug, Deserialize)]
struct EngineEntry {
    minimum: String,
    tested: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TestedManifest {
    engines: HashMap<String, EngineEntry>,
}

impl TestedManifest {
    /// The embedded manifest, or an empty one if verification fails.
    pub fn embedded() -> Self {
        let parsed = verified_parse(MANIFEST, SIGNATURE, PUBLIC_KEY);
        if parsed.is_none() {
            tracing::error!("the embedded tested-version manifest failed verification");
        }
        parsed.unwrap_or_default()
    }

    pub fn support(&self, engine: &str, version: Option<&str>) -> VersionSupport {
        let (Some(entry), Some(version)) = (self.engines.get(engine), version) else {
            return VersionSupport::Unknown;
        };
        let (Some(found), Some(minimum)) = (numbers(version), numbers(&entry.minimum)) else {
            return VersionSupport::Unknown;
        };
        if found < minimum {
            VersionSupport::BelowMinimum
        } else if entry.tested.iter().any(|tested| tested == version) {
            VersionSupport::Tested
        } else {
            VersionSupport::Untested
        }
    }
}

fn verified_parse(manifest: &[u8], signature: &str, key: &str) -> Option<TestedManifest> {
    let key: [u8; 32] = from_hex(key.trim())?.try_into().ok()?;
    let signature: [u8; 64] = from_hex(signature.trim())?.try_into().ok()?;
    VerifyingKey::from_bytes(&key)
        .ok()?
        .verify(manifest, &Signature::from_bytes(&signature))
        .ok()?;
    serde_json::from_slice(manifest).ok()
}

/// A comparable version. Pre-release suffixes sort as their release.
fn numbers(version: &str) -> Option<Vec<u64>> {
    let core = version.split(['-', '+']).next()?;
    let mut parts: Vec<u64> = core
        .split('.')
        .map(|part| part.parse().ok())
        .collect::<Option<_>>()?;
    parts.resize(3, 0);
    Some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_verifies_and_grades_versions() {
        let manifest = TestedManifest::embedded();
        assert_eq!(
            manifest.support("codex", Some("0.166.0")),
            VersionSupport::Tested
        );
        assert_eq!(
            manifest.support("claude", Some("2.1.150")),
            VersionSupport::Tested
        );
        assert_eq!(
            manifest.support("claude", Some("2.2.0")),
            VersionSupport::Untested
        );
        assert_eq!(
            manifest.support("codex", Some("0.9.0")),
            VersionSupport::BelowMinimum
        );
        assert_eq!(manifest.support("codex", None), VersionSupport::Unknown);
        assert_eq!(
            manifest.support("other", Some("1.0")),
            VersionSupport::Unknown
        );
    }

    #[test]
    fn a_changed_manifest_is_rejected() {
        let mut changed = MANIFEST.to_vec();
        changed[20] ^= 1;
        assert!(verified_parse(&changed, SIGNATURE, PUBLIC_KEY).is_none());
        assert!(verified_parse(MANIFEST, SIGNATURE, PUBLIC_KEY).is_some());
    }

    #[test]
    fn numeric_comparison_is_not_lexical() {
        assert!(numbers("0.166.0") > numbers("0.20.0"));
    }
}
