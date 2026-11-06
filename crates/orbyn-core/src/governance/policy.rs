//! Pure policy evaluation. Deny beats ask beats allow; no matching rule means ask.

use orbyn_contracts::{ActionKind, PolicyDecision, PolicyEffect, PolicyRule};

/// Decides one action against the full rule set.
pub fn evaluate(
    rules: &[PolicyRule],
    kind: ActionKind,
    target: &str,
    engine: &str,
) -> PolicyDecision {
    let mut strongest: Option<&PolicyRule> = None;
    for rule in rules {
        if rule.kind != kind || rule.engine.as_deref().is_some_and(|only| only != engine) {
            continue;
        }
        if !rule_applies(rule, target) {
            continue;
        }
        if strongest.is_none_or(|current| rank(rule.effect) > rank(current.effect)) {
            strongest = Some(rule);
        }
    }
    match strongest {
        Some(rule) => PolicyDecision {
            effect: rule.effect,
            rule_id: Some(rule.id.clone()),
            source: "rule".into(),
            reason: format!("Matched rule {}", rule.pattern),
        },
        None => PolicyDecision {
            effect: PolicyEffect::Ask,
            rule_id: None,
            source: "default".into(),
            reason: "No rule matched".into(),
        },
    }
}

fn rank(effect: PolicyEffect) -> u8 {
    match effect {
        PolicyEffect::Allow => 0,
        PolicyEffect::Ask => 1,
        PolicyEffect::Deny => 2,
    }
}

fn rule_applies(rule: &PolicyRule, target: &str) -> bool {
    if let Some(literal) = rule.pattern.strip_prefix('=') {
        return literal == target;
    }
    if !glob_match(&rule.pattern, target) {
        return false;
    }
    // `git *` must not grant `git status; rm -rf /`. A wildcard allow covers one
    // simple command; a compound command needs an exact rule or a person.
    !(rule.effect == PolicyEffect::Allow
        && rule.kind == ActionKind::Command
        && rule.pattern.contains('*')
        && has_shell_control(target))
}

fn has_shell_control(command: &str) -> bool {
    command.contains([';', '|', '&', '`', '\n', '\r', '>', '<']) || command.contains("$(")
}

/// `*` matches any run of characters, including separators. Linear in practice:
/// on a mismatch only the most recent star is retried.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    let mut retry: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == '*' {
            retry = Some((p, t));
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some((star, consumed)) = retry {
            p = star + 1;
            t = consumed + 1;
            retry = Some((star, consumed + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(effect: PolicyEffect, kind: ActionKind, pattern: &str) -> PolicyRule {
        PolicyRule {
            id: pattern.to_owned(),
            effect,
            kind,
            pattern: pattern.to_owned(),
            engine: None,
            note: None,
            created_at: String::new(),
        }
    }

    #[test]
    fn glob_semantics() {
        assert!(glob_match("git *", "git status"));
        assert!(glob_match("*", ""));
        assert!(glob_match("a*b*c", "a--b--c"));
        assert!(glob_match(
            "https://*.example.com/*",
            "https://a.example.com/x/y"
        ));
        assert!(!glob_match("git *", "gitx status"));
        assert!(!glob_match("abc", "abcd"));
        assert!(!glob_match("a*c", "abd"));
    }

    #[test]
    fn no_rule_means_ask() {
        let decision = evaluate(&[], ActionKind::Computer, "x", "e");
        assert_eq!(decision.effect, PolicyEffect::Ask);
        assert_eq!(decision.source, "default");
    }

    #[test]
    fn deny_beats_allow_in_either_order() {
        let allow = rule(PolicyEffect::Allow, ActionKind::Tool, "*");
        let deny = rule(PolicyEffect::Deny, ActionKind::Tool, "secret*");
        for rules in [
            vec![allow.clone(), deny.clone()],
            vec![deny.clone(), allow.clone()],
        ] {
            let decision = evaluate(&rules, ActionKind::Tool, "secret-thing", "e");
            assert_eq!(decision.effect, PolicyEffect::Deny);
            assert_eq!(decision.rule_id.as_deref(), Some("secret*"));
        }
        assert_eq!(
            evaluate(&[allow, deny], ActionKind::Tool, "public", "e").effect,
            PolicyEffect::Allow
        );
    }

    #[test]
    fn ask_beats_allow() {
        let rules = [
            rule(PolicyEffect::Allow, ActionKind::Tool, "*"),
            rule(PolicyEffect::Ask, ActionKind::Tool, "x*"),
        ];
        assert_eq!(
            evaluate(&rules, ActionKind::Tool, "xy", "e").effect,
            PolicyEffect::Ask
        );
    }

    #[test]
    fn rules_scope_to_kind_and_engine() {
        let mut only_codex = rule(PolicyEffect::Allow, ActionKind::Tool, "*");
        only_codex.engine = Some("codex".into());
        assert_eq!(
            evaluate(
                std::slice::from_ref(&only_codex),
                ActionKind::Tool,
                "x",
                "claude"
            )
            .effect,
            PolicyEffect::Ask
        );
        assert_eq!(
            evaluate(
                std::slice::from_ref(&only_codex),
                ActionKind::Tool,
                "x",
                "codex"
            )
            .effect,
            PolicyEffect::Allow
        );
        assert_eq!(
            evaluate(&[only_codex], ActionKind::Command, "x", "codex").effect,
            PolicyEffect::Ask
        );
    }

    #[test]
    fn wildcard_allow_does_not_cover_compound_commands() {
        let rules = [rule(PolicyEffect::Allow, ActionKind::Command, "git *")];
        for target in [
            "git status; rm -rf /",
            "git log | sh",
            "git log && curl x",
            "git $(rm -rf /)",
            "git `id`",
            "git log > /etc/hosts",
        ] {
            assert_eq!(
                evaluate(&rules, ActionKind::Command, target, "e").effect,
                PolicyEffect::Ask,
                "{target}"
            );
        }
        assert_eq!(
            evaluate(&rules, ActionKind::Command, "git status", "e").effect,
            PolicyEffect::Allow
        );
    }

    #[test]
    fn deny_still_matches_compound_commands() {
        let rules = [rule(PolicyEffect::Deny, ActionKind::Command, "*rm -rf*")];
        assert_eq!(
            evaluate(&rules, ActionKind::Command, "ls; rm -rf /", "e").effect,
            PolicyEffect::Deny
        );
    }

    #[test]
    fn exact_rule_treats_star_literally() {
        let rules = [rule(PolicyEffect::Allow, ActionKind::Command, "=rm *.tmp")];
        assert_eq!(
            evaluate(&rules, ActionKind::Command, "rm *.tmp", "e").effect,
            PolicyEffect::Allow
        );
        assert_eq!(
            evaluate(&rules, ActionKind::Command, "rm a.tmp", "e").effect,
            PolicyEffect::Ask
        );
    }
}
