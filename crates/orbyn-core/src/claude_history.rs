//! One Claude conversation's messages, read from Claude's own history folder
//! (`CLAUDE_CONFIG_DIR`, else `~/.claude`, then `projects/<folder>/<session>.jsonl`).
//! Reading needs no sign-in and writes nothing. A caller names a session by id, and
//! optionally its working folder, never by path.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{CoreError, Result};
use crate::usage::{Engine, history_root};

/// The largest transcript read, in bytes.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Project folders looked through when no working folder is given.
const MAX_FOLDERS: usize = 4000;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryOptions {
    /// The session's working folder; only that project's history is read.
    pub dir: Option<String>,
    #[serde(default)]
    pub include_system_messages: bool,
    /// Stop after the message with this id.
    pub up_to_message_id: Option<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Claude's folder name for a working folder: every character that is not an ASCII
/// letter or digit becomes `-`, so `C:\code\app` is `C--code-app`.
pub fn project_folder_name(dir: &str) -> String {
    dir.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn find_transcript(root: &Path, session: &str, dir: Option<&str>) -> Option<PathBuf> {
    let file = format!("{session}.jsonl");
    if let Some(dir) = dir {
        let path = root.join(project_folder_name(dir)).join(&file);
        return path.is_file().then_some(path);
    }
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .take(MAX_FOLDERS)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path().join(&file))
        .find(|path| path.is_file())
}

/// The session's user and assistant messages in file order, and system ones when
/// asked. Side-chain (subagent) entries are left out.
pub fn session_messages(session: &str, options: &HistoryOptions) -> Result<Vec<Value>> {
    let root = history_root(Engine::Claude)
        .ok_or_else(|| CoreError::Unsupported("No home folder, so no Claude history.".into()))?;
    session_messages_in(&root, session, options)
}

fn session_messages_in(root: &Path, session: &str, options: &HistoryOptions) -> Result<Vec<Value>> {
    if !valid_id(session) {
        return Err(CoreError::Invalid(
            "That is not a Claude session id.".into(),
        ));
    }
    let path = find_transcript(root, session, options.dir.as_deref())
        .ok_or_else(|| CoreError::NotFound("Claude session".into()))?;
    let file = std::fs::File::open(&path)?;
    if file.metadata()?.len() > MAX_FILE_BYTES {
        return Err(CoreError::Invalid(
            "This Claude session is too large to read here.".into(),
        ));
    }
    let mut messages = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        // A line cut off by a crash is skipped, as Claude itself does.
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
        let wanted = matches!(kind, "user" | "assistant")
            || (kind == "system" && options.include_system_messages);
        if !wanted || entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let uuid = entry.get("uuid").cloned().unwrap_or(Value::Null);
        let last = options
            .up_to_message_id
            .as_deref()
            .is_some_and(|wanted| uuid.as_str() == Some(wanted));
        messages.push(json!({
            "type": kind,
            "uuid": uuid,
            "session_id": entry.get("sessionId").cloned().unwrap_or_else(|| json!(session)),
            "message": entry.get("message").cloned().unwrap_or(Value::Null),
            "parent_tool_use_id": Value::Null,
        }));
        if last {
            break;
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn write(root: &Path, folder: &str, session: &str, lines: &[Value]) {
        let dir = root.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let mut text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        text.push_str("{\"type\":\"user\",\"cut");
        std::fs::write(dir.join(format!("{session}.jsonl")), text).unwrap();
    }

    #[test]
    fn folder_names_follow_claude_on_unix_and_windows_paths() {
        assert_eq!(project_folder_name("/Users/a/my app"), "-Users-a-my-app");
        assert_eq!(
            project_folder_name(r"C:\Users\a\my_app"),
            "C--Users-a-my-app"
        );
    }

    #[test]
    fn reads_messages_in_order_up_to_an_id_and_only_where_asked() {
        let dir = TempDir::new();
        let root = dir.path();
        let id = "0f3c2b1a-1111-4222-8333-444455556666";
        write(
            root,
            &project_folder_name(r"C:\work\app"),
            id,
            &[
                json!({"type":"summary","summary":"x"}),
                json!({"type":"user","uuid":"u1","sessionId":id,"message":{"role":"user","content":"hi"}}),
                json!({"type":"system","uuid":"s1","sessionId":id,"content":"note"}),
                json!({"type":"assistant","uuid":"a1","sessionId":id,"isSidechain":true,"message":{}}),
                json!({"type":"assistant","uuid":"a2","sessionId":id,"message":{"role":"assistant","content":"hello"}}),
                json!({"type":"user","uuid":"u3","sessionId":id,"message":{"role":"user","content":"more"}}),
            ],
        );
        let all = session_messages_in(root, id, &HistoryOptions::default()).unwrap();
        let uuids: Vec<_> = all.iter().map(|m| m["uuid"].clone()).collect();
        assert_eq!(uuids, [json!("u1"), json!("a2"), json!("u3")]);
        assert_eq!(all[1]["message"]["content"], "hello");

        let options = HistoryOptions {
            dir: Some(r"C:\work\app".into()),
            include_system_messages: true,
            up_to_message_id: Some("a2".into()),
        };
        let some = session_messages_in(root, id, &options).unwrap();
        let uuids: Vec<_> = some.iter().map(|m| m["uuid"].clone()).collect();
        assert_eq!(uuids, [json!("u1"), json!("s1"), json!("a2")]);

        let elsewhere = HistoryOptions {
            dir: Some("/other".into()),
            ..HistoryOptions::default()
        };
        assert!(matches!(
            session_messages_in(root, id, &elsewhere),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn an_id_cannot_name_a_path() {
        let dir = TempDir::new();
        for id in ["../secret", r"..\secret", "", "a/b"] {
            assert!(matches!(
                session_messages_in(dir.path(), id, &HistoryOptions::default()),
                Err(CoreError::Invalid(_))
            ));
        }
    }
}
