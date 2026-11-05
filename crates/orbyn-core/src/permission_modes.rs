//! Which permission modes each provider offers, and what a saved mode runs as.
//!
//! A thread keeps the mode it was given. A run on an engine that does not offer that
//! mode runs Supervised, which is also what the composer shows, so a looser mode is
//! never assumed for an engine that cannot honour it.

use orbyn_contracts::PermissionMode::{self, Auto, AutoEdits, FullAccess, Supervised};

/// The modes a provider offers, by the id its driver family or known engine uses.
/// Providers with no row here offer every mode.
pub fn offered(family: &str) -> Vec<PermissionMode> {
    match family {
        // OpenCode has no classifier of its own, so its Auto would be Supervised.
        "opencode" => vec![Supervised, AutoEdits, FullAccess],
        "fx" => vec![Supervised, Auto],
        "muse" => vec![Supervised, FullAccess],
        "pi" => vec![Supervised, AutoEdits, FullAccess],
        _ => PermissionMode::ALL.to_vec(),
    }
}

/// What a saved mode runs as on an engine offering `modes`.
pub fn effective(modes: &[PermissionMode], saved: PermissionMode) -> PermissionMode {
    if modes.contains(&saved) {
        saved
    } else {
        Supervised
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_matrix_matches_each_provider() {
        assert_eq!(offered("fx"), [Supervised, Auto]);
        assert_eq!(offered("muse"), [Supervised, FullAccess]);
        assert_eq!(offered("pi"), [Supervised, AutoEdits, FullAccess]);
        assert_eq!(offered("opencode"), [Supervised, AutoEdits, FullAccess]);
        assert_eq!(offered("claude"), PermissionMode::ALL);
        assert_eq!(offered("codex"), PermissionMode::ALL);
        assert_eq!(offered("my-agent"), PermissionMode::ALL);
    }

    #[test]
    fn a_mode_the_engine_lacks_runs_supervised() {
        // Pi's stored Auto shows Supervised, not the nearer Auto-accept edits.
        assert_eq!(effective(&offered("pi"), Auto), Supervised);
        assert_eq!(effective(&offered("opencode"), Auto), Supervised);
        assert_eq!(effective(&offered("muse"), AutoEdits), Supervised);
        assert_eq!(effective(&offered("fx"), FullAccess), Supervised);
        assert_eq!(effective(&offered("pi"), FullAccess), FullAccess);
        assert_eq!(effective(&offered("claude"), Auto), Auto);
    }
}
