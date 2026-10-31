//! Engines Orbyn can run with nothing set up, because each speaks ACP from its own
//! CLI. One is offered only when its program is on this machine, and its own login
//! stays its own: an agent that is not signed in says so when it runs.

use orbyn_contracts::{CustomEngine, EngineTier};

/// One CLI and how to reach its ACP mode.
pub struct KnownEngine {
    pub id: &'static str,
    pub name: &'static str,
    /// Tried in order. The first found is what runs.
    pub programs: &'static [&'static str],
    pub args: &'static [&'static str],
    /// Set for this process alone, to keep the agent asking before it acts.
    pub env: &'static [(&'static str, &'static str)],
    /// False for an agent that cannot ask before an edit, which rule 8 must label.
    pub asks: bool,
}

pub const KNOWN_ENGINES: &[KnownEngine] = &[
    KnownEngine {
        id: "antigravity",
        name: "Antigravity",
        programs: &["agy_acp_server", "agy_acp_server.par"],
        args: &[],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "cline",
        name: "Cline",
        programs: &["cline"],
        args: &["--acp"],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "commandcode",
        name: "Command Code",
        programs: &["command-code"],
        args: &["acp"],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "copilot",
        name: "GitHub Copilot",
        programs: &["copilot"],
        args: &["--no-auto-update", "--acp", "--stdio"],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "cursor",
        name: "Cursor",
        programs: &["cursor-agent"],
        args: &["acp"],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "deepseek",
        name: "DeepSeek",
        programs: &["dsh"],
        args: &["--profile", "acp"],
        env: &[("DSH_PERMISSION_MODE", "workspace-write")],
        asks: false,
    },
    KnownEngine {
        id: "devin",
        name: "Devin",
        programs: &["devin"],
        args: &["acp"],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "grok",
        name: "Grok Build",
        programs: &["grok"],
        // Global flags go before `agent`. Stating the mode outranks a saved `yolo`.
        args: &[
            "--no-auto-update",
            "--permission-mode",
            "default",
            "agent",
            "stdio",
        ],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "hermes",
        name: "Hermes Agent",
        programs: &["hermes"],
        args: &["acp"],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "kilo",
        name: "Kilo Code",
        programs: &["kilo"],
        args: &["acp"],
        env: &[("KILO_DISABLE_AUTOUPDATE", "true")],
        asks: true,
    },
    KnownEngine {
        id: "kimi",
        name: "Kimi Code",
        programs: &["kimi"],
        args: &["acp"],
        env: &[],
        asks: true,
    },
    KnownEngine {
        id: "opencode",
        name: "OpenCode",
        programs: &["opencode"],
        args: &["acp"],
        // Its defaults allow edits. Inline settings outrank the person's own file.
        env: &[("OPENCODE_CONFIG_CONTENT", r#"{"permission":{"*":"ask"}}"#)],
        asks: true,
    },
];

impl KnownEngine {
    /// The program to run: the first one found, or the first named so that a thread
    /// on an engine since removed fails with its proper name.
    fn program(&self) -> &'static str {
        self.programs
            .iter()
            .copied()
            .find(|program| crate::process::resolve(program).is_some())
            .unwrap_or(self.programs[0])
    }

    pub fn is_installed(&self) -> bool {
        self.programs
            .iter()
            .any(|program| crate::process::resolve(program).is_some())
    }

    pub fn as_custom(&self) -> CustomEngine {
        CustomEngine {
            id: self.id.to_owned(),
            name: self.name.to_owned(),
            tier: EngineTier::Acp,
            target: self.program().to_owned(),
            args: self.args.iter().map(|arg| (*arg).to_owned()).collect(),
        }
    }
}

pub fn known_engine(id: &str) -> Option<&'static KnownEngine> {
    KNOWN_ENGINES.iter().find(|engine| engine.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_none_takes_a_built_in_name() {
        for engine in KNOWN_ENGINES {
            let same = KNOWN_ENGINES.iter().filter(|e| e.id == engine.id).count();
            assert_eq!(same, 1, "{}", engine.id);
            assert!(!matches!(engine.id, "claude" | "codex"));
            assert!(!engine.programs.is_empty());
        }
    }

    #[test]
    fn each_launch_is_only_what_the_table_says() {
        let copilot = known_engine("copilot").unwrap().as_custom();
        assert_eq!(copilot.tier, EngineTier::Acp);
        assert_eq!(copilot.args, ["--no-auto-update", "--acp", "--stdio"]);
        assert_eq!(known_engine("cursor").unwrap().programs, ["cursor-agent"]);
        assert!(known_engine("nothing").is_none());
    }

    #[test]
    fn the_engine_that_cannot_ask_is_the_only_one_marked() {
        let silent: Vec<_> = KNOWN_ENGINES.iter().filter(|e| !e.asks).collect();
        assert_eq!(silent.len(), 1);
        assert_eq!(silent[0].id, "deepseek");
    }
}
