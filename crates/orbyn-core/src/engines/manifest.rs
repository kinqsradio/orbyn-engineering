//! The signed list of engine versions Orbyn has tested. The default ships inside
//! the binary with its detached ed25519 signature; a bad signature yields
//! `Unknown`, never a claim of support.

use std::collections::HashMap;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use orbyn_contracts::{CompatibilityStatus, VersionSupport};
use serde::Deserialize;

use crate::util::from_hex;

const MANIFEST: &[u8] = include_bytes!("tested-versions.json");
const SIGNATURE: &str = include_str!("tested-versions.sig");
const PUBLIC_KEY: &str = include_str!("tested-versions.pub");

#[derive(Debug, Deserialize)]
struct KnownProblem {
    version: String,
    status: CompatibilityStatus,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EngineEntry {
    minimum: String,
    tested: Vec<String>,
    /// The version the owner pins for this engine. Without it the newest tested
    /// version is the recommendation.
    #[serde(default)]
    recommended: Option<String>,
    #[serde(default)]
    known_problems: Vec<KnownProblem>,
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

    /// The version the owner signed for this engine, or the newest tested one.
    pub fn recommended(&self, engine: &str) -> Option<String> {
        let entry = self.engines.get(engine)?;
        if let Some(pinned) = &entry.recommended {
            return Some(pinned.clone());
        }
        entry
            .tested
            .iter()
            .max_by_key(|version| numbers(version))
            .cloned()
    }

    /// Why this version is outside the manifest's support, and what to do instead.
    /// A version the manifest does not mention produces no claim at all.
    pub fn problem(&self, engine: &str, version: &str) -> Option<(CompatibilityStatus, String)> {
        let entry = self.engines.get(engine)?;
        if let Some(known) = entry
            .known_problems
            .iter()
            .find(|known| known.version == version)
        {
            let status = known.status;
            return Some((
                status,
                known.message.clone().unwrap_or_else(|| message(status)),
            ));
        }
        let (found, minimum) = (numbers(version)?, numbers(&entry.minimum)?);
        (found < minimum).then(|| {
            (
                CompatibilityStatus::Unsupported,
                message(CompatibilityStatus::Unsupported),
            )
        })
    }
}

/// The wording for each status, before any recommendation is appended.
pub fn message(status: CompatibilityStatus) -> String {
    match status {
        CompatibilityStatus::Broken => {
            "This engine version is known to be incompatible with this Orbyn release.".into()
        }
        CompatibilityStatus::Unsupported => {
            "This engine version is outside the supported range for this Orbyn release.".into()
        }
        CompatibilityStatus::Graceful => {
            "This engine version has limited compatibility with this Orbyn release.".into()
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

/// True when `latest` is a newer version than `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((numbers(latest), numbers(current)), (Some(l), Some(c)) if l > c)
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
    fn a_different_valid_key_cannot_verify_the_embedded_signature() {
        let other = ed25519_dalek::SigningKey::from_bytes(&[7; 32]).verifying_key();
        let key = crate::util::hex(&other.to_bytes());
        assert!(verified_parse(MANIFEST, SIGNATURE, &key).is_none());
    }

    #[test]
    fn malformed_signature_and_key_encodings_are_rejected() {
        for signature in ["", "zz", &"00".repeat(63), &"00".repeat(65)] {
            assert!(verified_parse(MANIFEST, signature, PUBLIC_KEY).is_none());
        }
        for key in ["", "zz", &"00".repeat(31), &"00".repeat(33)] {
            assert!(verified_parse(MANIFEST, SIGNATURE, key).is_none());
        }
    }

    #[test]
    fn tampered_and_noncanonical_signatures_are_rejected() {
        let mut signature = from_hex(SIGNATURE.trim()).unwrap();
        signature[0] ^= 1;
        assert!(verified_parse(MANIFEST, &crate::util::hex(&signature), PUBLIC_KEY).is_none());

        let mut signature = from_hex(SIGNATURE.trim()).unwrap();
        // The scalar half must be smaller than the Ed25519 subgroup order.
        signature[32..].fill(0xff);
        assert!(verified_parse(MANIFEST, &crate::util::hex(&signature), PUBLIC_KEY).is_none());
    }

    #[test]
    fn numeric_comparison_is_not_lexical() {
        assert!(numbers("0.166.0") > numbers("0.20.0"));
    }

    #[test]
    fn the_recommendation_is_the_signed_pin_or_the_newest_tested() {
        let manifest = TestedManifest::embedded();
        // Nothing is pinned in the signed manifest, so the newest tested version wins.
        assert_eq!(manifest.recommended("codex").as_deref(), Some("0.166.0"));
        assert_eq!(manifest.recommended("claude").as_deref(), Some("2.1.150"));
        assert_eq!(manifest.recommended("other"), None);
        let pinned: TestedManifest = serde_json::from_str(
            r#"{"engines":{"codex":{"minimum":"0.166.0","tested":["0.166.0","0.170.0"],"recommended":"0.166.0"}}}"#,
        )
        .unwrap();
        assert_eq!(pinned.recommended("codex").as_deref(), Some("0.166.0"));
    }

    #[test]
    fn only_the_signed_manifest_can_raise_a_problem() {
        let manifest = TestedManifest::embedded();
        let (status, text) = manifest.problem("codex", "0.160.0").unwrap();
        assert_eq!(status, CompatibilityStatus::Unsupported);
        assert!(text.contains("outside the supported range"));
        assert!(manifest.problem("codex", "0.166.0").is_none());
        // An untested version above the minimum is not a known problem.
        assert!(manifest.problem("claude", "2.1.318").is_none());
        assert!(manifest.problem("other", "1.0.0").is_none());
        assert!(manifest.problem("codex", "not-a-version").is_none());

        let signed: TestedManifest = serde_json::from_str(
            r#"{"engines":{"codex":{"minimum":"0.166.0","tested":["0.166.0"],
                "known_problems":[{"version":"0.165.0","status":"broken"},
                                  {"version":"0.164.0","status":"graceful","message":"Turn limits are wrong."}]}}}"#,
        )
        .unwrap();
        let (status, text) = signed.problem("codex", "0.165.0").unwrap();
        assert_eq!(status, CompatibilityStatus::Broken);
        assert!(text.contains("known to be incompatible"));
        let (status, text) = signed.problem("codex", "0.164.0").unwrap();
        assert_eq!(status, CompatibilityStatus::Graceful);
        assert_eq!(text, "Turn limits are wrong.");
    }
}
