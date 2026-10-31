//! Keybindings: built-in defaults, then the person's file over them. The file is
//! read leniently, with `//` comments and trailing commas allowed, and one bad entry
//! is reported without losing the others. New defaults reach a person with an
//! existing file, because the file holds only their changes.

use std::path::{Path, PathBuf};

use orbyn_contracts::{KeybindingConflict, KeybindingRule, KeybindingsView};
use serde_json::Value;

use crate::app::Core;
use crate::error::{CoreError, Result};

const MAX_RULES: usize = 256;
const MAX_FIELD: usize = 256;

/// `(key, command, when)`.
const DEFAULTS: &[(&str, &str, &str)] = &[
    ("mod+b", "sidebar.toggle", ""),
    ("f6", "workspace.focusNext", ""),
    ("shift+f6", "workspace.focusPrevious", ""),
    ("mod+[", "navigation.back", "!terminalFocus"),
    ("mod+]", "navigation.forward", "!terminalFocus"),
    ("mod+j", "terminal.toggle", ""),
    ("mod+alt+b", "rightPanel.toggle", ""),
    ("mod+shift+b", "threadPanel.toggle", "!terminalFocus"),
    (
        "mod+t",
        "rightPanel.new",
        "rightPanelOpen && !terminalFocus",
    ),
    ("mod+d", "terminal.split", "terminalFocus"),
    ("mod+shift+d", "terminal.splitVertical", "terminalFocus"),
    ("mod+n", "terminal.new", "terminalFocus"),
    ("mod+w", "terminal.close", "terminalFocus"),
    ("mod+w", "rightPanel.close", "!terminalFocus"),
    ("mod+shift+t", "view.reopenClosed", ""),
    ("mod+d", "diff.toggle", "!terminalFocus"),
    ("mod+shift+j", "preview.toggle", ""),
    ("mod+r", "preview.refresh", "previewFocus"),
    ("mod+l", "preview.focusUrl", "previewFocus"),
    ("mod+=", "preview.zoomIn", "previewFocus"),
    ("mod+-", "preview.zoomOut", "previewFocus"),
    ("mod+0", "preview.resetZoom", "previewFocus"),
    ("mod+k", "commandPalette.toggle", "!terminalFocus"),
    ("mod+p", "filePicker.toggle", "!terminalFocus"),
    ("mod+shift+f", "projectSearch.toggle", "!terminalFocus"),
    ("mod+u", "usage.open", "!terminalFocus"),
    ("mod+s", "composer.stash", "!terminalFocus"),
    (
        "mod+shift+enter",
        "thread.steerQueuedMessage",
        "!terminalFocus",
    ),
    ("alt+arrowup", "thread.editQueuedMessage", "composerFocus"),
    (
        "mod+enter",
        "composer.sendAlternate",
        "composerFocus && turnRunning",
    ),
    ("mod+n", "chat.new", "!terminalFocus"),
    ("mod+shift+n", "chat.newLocal", "!terminalFocus"),
    ("mod+alt+n", "chat.newWithoutProject", "!terminalFocus"),
    ("mod+f", "chat.find", "!terminalFocus && !previewFocus"),
    ("mod+shift+m", "modelPicker.toggle", "!terminalFocus"),
    ("mod+shift+e", "composer.effort", "!terminalFocus"),
    ("mod+shift+a", "composer.mode", "!terminalFocus"),
    ("mod+shift+g", "composer.branch", "!terminalFocus"),
    ("mod+shift+k", "pullRequest.copyNumber", "!terminalFocus"),
    ("mod+o", "editor.openFavorite", ""),
    ("mod+shift+[", "thread.previous", ""),
    ("mod+shift+]", "thread.next", ""),
    ("mod+shift+c", "thread.copyReference", "!terminalFocus"),
    ("mod+shift+s", "thread.settle", "!terminalFocus"),
    ("mod+shift+p", "thread.pin", "!terminalFocus"),
    ("mod+z", "thread.undo", "!terminalFocus && !editableFocus"),
    ("c", "usage.cost", "usagePageOpen"),
    ("t", "usage.tokens", "usagePageOpen"),
    ("l", "usage.limits", "usagePageOpen"),
    ("mod+shift+1", "usage.period.day", "usagePageOpen"),
    ("mod+shift+2", "usage.period.week", "usagePageOpen"),
    ("mod+shift+3", "usage.period.month", "usagePageOpen"),
    ("mod+shift+4", "usage.period.quarter", "usagePageOpen"),
];

fn defaults() -> Vec<KeybindingRule> {
    DEFAULTS
        .iter()
        .map(|(key, command, when)| KeybindingRule {
            key: (*key).to_owned(),
            command: (*command).to_owned(),
            when: (!when.is_empty()).then(|| (*when).to_owned()),
            remove: false,
        })
        .collect()
}

/// Removes `//` comments and trailing commas, leaving strings alone.
fn relax(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                out.extend(chars.next());
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ']' | '}' => {
                let kept = out.trim_end().len();
                if out[..kept].ends_with(',') {
                    out.truncate(kept - 1);
                }
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

fn valid(rule: &KeybindingRule) -> bool {
    !rule.key.trim().is_empty()
        && !rule.command.trim().is_empty()
        && rule.key.len() <= MAX_FIELD
        && rule.command.len() <= MAX_FIELD
        && rule
            .when
            .as_ref()
            .is_none_or(|when| when.len() <= MAX_FIELD)
}

/// The rules a file holds, and what was wrong with the rest of it.
fn parse(text: &str) -> (Vec<KeybindingRule>, Vec<String>) {
    let items = match serde_json::from_str::<Value>(&relax(text)) {
        Ok(Value::Array(items)) => items,
        Ok(_) => {
            return (
                Vec::new(),
                vec!["The file must hold a list of rules.".into()],
            );
        }
        Err(error) => return (Vec::new(), vec![format!("The file is not valid: {error}")]),
    };
    let mut rules = Vec::new();
    let mut issues = Vec::new();
    for (index, item) in items.into_iter().take(MAX_RULES).enumerate() {
        match serde_json::from_value::<KeybindingRule>(item) {
            Ok(rule) if valid(&rule) => rules.push(rule),
            _ => issues.push(format!("Rule {} was skipped.", index + 1)),
        }
    }
    (rules, issues)
}

/// The file's rules over the defaults. A later rule for one key and context wins,
/// and `remove` takes a rule out.
fn merged(own: &[KeybindingRule]) -> Vec<KeybindingRule> {
    let mut rules = defaults();
    for rule in own {
        if rule.remove {
            rules.retain(|known| !(known.key == rule.key && known.command == rule.command));
            continue;
        }
        rules.retain(|known| !(known.command == rule.command && known.when == rule.when));
        rules.retain(|known| !(known.key == rule.key && known.when == rule.when));
        rules.push(rule.clone());
    }
    rules
}

/// One key in one exact context with more than one command. Different contexts are
/// how one key does two jobs, so they are not conflicts.
fn conflicts(rules: &[KeybindingRule]) -> Vec<KeybindingConflict> {
    let mut found: Vec<KeybindingConflict> = Vec::new();
    for rule in rules {
        match found
            .iter_mut()
            .find(|known| known.key == rule.key && known.when == rule.when)
        {
            Some(known) => known.commands.push(rule.command.clone()),
            None => found.push(KeybindingConflict {
                key: rule.key.clone(),
                when: rule.when.clone(),
                commands: vec![rule.command.clone()],
            }),
        }
    }
    found.retain(|conflict| conflict.commands.len() > 1);
    found
}

fn read(path: &Path) -> (Vec<KeybindingRule>, Vec<String>) {
    std::fs::read_to_string(path).map_or_else(|_| (Vec::new(), Vec::new()), |text| parse(&text))
}

impl Core {
    fn keybindings_path(&self) -> PathBuf {
        self.config.data_dir.join("keybindings.json")
    }

    pub fn keybindings(&self) -> KeybindingsView {
        let path = self.keybindings_path();
        let (own, issues) = read(&path);
        let rules = merged(&own);
        KeybindingsView {
            path: path.to_string_lossy().into_owned(),
            conflicts: conflicts(&rules),
            rules,
            issues,
        }
    }

    /// Adds or changes a rule in the file, by rename so a crash cannot truncate it.
    /// A file that does not parse is left for the person to fix.
    pub fn save_keybinding(&self, rule: &KeybindingRule) -> Result<KeybindingsView> {
        if !valid(rule) {
            return Err(CoreError::Invalid(
                "A rule needs a key and a command.".into(),
            ));
        }
        let path = self.keybindings_path();
        let (mut own, issues) = read(&path);
        if !issues.is_empty() {
            return Err(CoreError::Invalid(
                "Fix the keybindings file before changing it here.".into(),
            ));
        }
        own.retain(|known| {
            !(known.command == rule.command && known.when == rule.when)
                && !(known.key == rule.key && known.command == rule.command)
        });
        own.push(rule.clone());
        let partial = path.with_extension("json.partial");
        std::fs::write(&partial, serde_json::to_vec_pretty(&own)?)?;
        std::fs::rename(&partial, &path)?;
        Ok(self.keybindings())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(key: &str, command: &str, when: Option<&str>) -> KeybindingRule {
        KeybindingRule {
            key: key.into(),
            command: command.into(),
            when: when.map(str::to_owned),
            remove: false,
        }
    }

    #[test]
    fn the_defaults_have_no_conflicts() {
        assert!(
            conflicts(&defaults()).is_empty(),
            "{:?}",
            conflicts(&defaults())
        );
    }

    #[test]
    fn a_lenient_file_keeps_good_rules_and_names_bad_ones() {
        let text = r#"[
            // mine
            { "key": "mod+x", "command": "a // not a comment" },
            { "key": "", "command": "b" },
            { "nonsense": true },
        ]"#;
        let (rules, issues) = parse(text);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].command, "a // not a comment");
        assert_eq!(issues.len(), 2);
        assert_eq!(parse("{ nope").1.len(), 1);
    }

    #[test]
    fn the_file_rebinds_removes_and_reports_conflicts() {
        let rules = merged(&[rule("mod+y", "sidebar.toggle", None)]);
        assert!(
            rules
                .iter()
                .any(|r| r.key == "mod+y" && r.command == "sidebar.toggle")
        );
        assert!(!rules.iter().any(|r| r.key == "mod+b"));
        let gone = KeybindingRule {
            remove: true,
            ..rule("mod+j", "terminal.toggle", None)
        };
        assert!(
            !merged(&[gone])
                .iter()
                .any(|r| r.command == "terminal.toggle")
        );
        let clash = [rule("mod+q", "one", None), rule("mod+q", "two", Some("x"))];
        assert!(conflicts(&merged(&clash)).is_empty(), "contexts differ");
        let same = [rule("a", "one", None), rule("a", "two", None)];
        assert_eq!(conflicts(&same)[0].commands, ["one", "two"]);
    }
}
