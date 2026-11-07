//! Claude and Codex conversations saved in the engines' own history folders, found
//! and imported as threads that resume them. Only the head of each file is read, for
//! its session id, folder and first prompt; nothing is written there, and a client
//! names a session only by engine and id, never by path.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use orbyn_contracts::{
    HistoryScan, HistorySession, HistorySessionImported, ImportHistorySession, NativeSessionCount,
};
use serde_json::Value;

use crate::agents::usage::{Engine, history_root};
use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::NewThread;

/// Files listed per engine, newest first.
const MAX_FILES: usize = 400;
/// Bytes and lines read from the head of one file.
const HEAD_BYTES: u64 = 64 * 1024;
const HEAD_LINES: usize = 200;
/// Folders visited under a history root, so a deep tree cannot stall the scan.
const MAX_DIRS: usize = 4000;
const MAX_TITLE: usize = 120;

struct Found {
    engine: Engine,
    path: PathBuf,
    modified: SystemTime,
}

fn engine_name(engine: Engine) -> &'static str {
    match engine {
        Engine::Claude => "claude",
        Engine::Codex => "codex",
    }
}

/// `.jsonl` files under `root`, newest first, at most `MAX_FILES`; true when cut.
fn history_files(engine: Engine, root: &Path) -> (Vec<Found>, bool) {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0;
    while let Some(dir) = pending.pop() {
        visited += 1;
        if visited > MAX_DIRS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            // Symlinks are not followed, so the scan stays inside the history folder.
            // Claude keeps a session's subagent transcripts under `<session>/subagents`,
            // with the parent's id; they are not conversations of their own.
            if kind.is_dir() && entry.file_name() != "subagents" {
                pending.push(path);
            } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
                let modified = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                found.push(Found {
                    engine,
                    path,
                    modified,
                });
            }
        }
    }
    found.sort_by_key(|file| std::cmp::Reverse(file.modified));
    let truncated = found.len() > MAX_FILES || visited > MAX_DIRS;
    found.truncate(MAX_FILES);
    (found, truncated)
}

/// `.jsonl` conversations under `root`, by the same rules as `history_files` but
/// without reading any file or its time, so counting stays cheap. True when the
/// folder count cut it short.
fn count_history_files(root: &Path) -> (u64, bool) {
    let mut count = 0;
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0;
    while let Some(dir) = pending.pop() {
        visited += 1;
        if visited > MAX_DIRS {
            return (count, true);
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() && entry.file_name() != "subagents" {
                pending.push(entry.path());
            } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
                count += 1;
            }
        }
    }
    (count, false)
}

struct Head {
    session_id: String,
    cwd: String,
    title: Option<String>,
}

fn clip(text: &str) -> Option<String> {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() || line.starts_with('<') {
        return None;
    }
    Some(line.chars().take(MAX_TITLE).collect())
}

fn claude_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return clip(text);
    }
    content
        .as_array()?
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .find_map(|part| part.get("text").and_then(Value::as_str).and_then(clip))
}

/// The session id, folder and first prompt from the first lines of a history file.
fn read_head(engine: Engine, path: &Path) -> Option<Head> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file.take(HEAD_BYTES));
    let mut session_id = None;
    let mut cwd = None;
    let mut title = None;
    for line in reader.lines().take(HEAD_LINES) {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        match engine {
            Engine::Claude => {
                session_id = session_id.or_else(|| text("sessionId"));
                cwd = cwd.or_else(|| text("cwd"));
                if title.is_none() && value.get("type").and_then(Value::as_str) == Some("user") {
                    title = value.get("message").and_then(claude_text);
                }
            }
            Engine::Codex => {
                let payload = value.get("payload");
                let field = |key: &str| {
                    payload
                        .and_then(|payload| payload.get(key))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("session_meta") => {
                        session_id = session_id.or_else(|| field("id"));
                        cwd = cwd.or_else(|| field("cwd"));
                    }
                    Some("event_msg") if field("type").as_deref() == Some("user_message") => {
                        title = title.or_else(|| field("message").as_deref().and_then(clip));
                    }
                    _ => {}
                }
            }
        }
        if session_id.is_some() && cwd.is_some() && title.is_some() {
            break;
        }
    }
    let session_id = session_id.filter(|id| valid_id(id))?;
    Some(Head {
        session_id,
        cwd: cwd.filter(|cwd| Path::new(cwd).is_absolute())?,
        title,
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn rfc3339(time: SystemTime) -> String {
    let seconds = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    time::OffsetDateTime::from_unix_timestamp(i64::try_from(seconds).unwrap_or(0))
        .ok()
        .and_then(|time| {
            time.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
}

fn same_folder(a: &str, b: &str) -> bool {
    let canonical = |path: &str| crate::util::canonicalize(Path::new(path)).ok();
    match (canonical(a), canonical(b)) {
        (Some(a), Some(b)) => a == b,
        _ => a == b,
    }
}

impl Core {
    /// How many conversations Claude or Codex keeps in its own history folder. It
    /// counts files and opens none.
    pub fn native_session_count(&self, engine: &str) -> Result<NativeSessionCount> {
        let kind = match engine {
            "claude" => Engine::Claude,
            "codex" => Engine::Codex,
            _ => {
                return Err(CoreError::Unsupported(
                    "Orbyn reads no history folder for this engine.".into(),
                ));
            }
        };
        let (count, truncated) = history_root(kind)
            .filter(|root| root.is_dir())
            .map_or((0, false), |root| count_history_files(&root));
        Ok(NativeSessionCount {
            engine: engine.to_owned(),
            count,
            truncated,
        })
    }

    /// Saved Claude and Codex conversations, newest first, matched to projects.
    pub fn scan_history(&self) -> Result<HistoryScan> {
        self.scan_history_in(&[
            (Engine::Claude, history_root(Engine::Claude)),
            (Engine::Codex, history_root(Engine::Codex)),
        ])
    }

    fn scan_history_in(&self, roots: &[(Engine, Option<PathBuf>)]) -> Result<HistoryScan> {
        let projects = self.store.list_projects()?;
        let mut sessions = Vec::new();
        let mut truncated = false;
        let mut folders: HashMap<String, Option<&orbyn_contracts::Project>> = HashMap::new();
        // Files are newest first, so the first of a session's files is the one kept.
        let mut seen = std::collections::HashSet::new();
        for (engine, root) in roots {
            let Some(root) = root.as_ref().filter(|root| root.is_dir()) else {
                continue;
            };
            let (files, cut) = history_files(*engine, root);
            truncated |= cut;
            for found in files {
                let Some(head) = read_head(found.engine, &found.path) else {
                    continue;
                };
                let project = *folders.entry(head.cwd.clone()).or_insert_with(|| {
                    projects
                        .iter()
                        .find(|project| !project.scratch && same_folder(&project.path, &head.cwd))
                });
                let name = engine_name(found.engine);
                if !seen.insert((name, head.session_id.clone())) {
                    continue;
                }
                let thread_id = match project {
                    Some(project) => {
                        self.store
                            .thread_for_native_session(name, &project.id, &head.session_id)?
                    }
                    None => None,
                };
                sessions.push(HistorySession {
                    engine: name.to_owned(),
                    title: head.title.unwrap_or_else(|| head.session_id.clone()),
                    session_id: head.session_id,
                    cwd: head.cwd,
                    updated_at: rfc3339(found.modified),
                    project_id: project.map(|project| project.id.clone()),
                    importable: project.is_some_and(|project| project.trusted),
                    thread_id,
                });
            }
        }
        Ok(HistoryScan {
            sessions,
            truncated,
        })
    }

    /// Imports one scanned session as a thread in its trusted project. The thread
    /// starts with no copied messages and resumes the engine's own session.
    pub fn import_history(&self, request: &ImportHistorySession) -> Result<HistorySessionImported> {
        let scan = self.scan_history()?;
        self.import_from(scan, request)
    }

    fn import_from(
        &self,
        scan: HistoryScan,
        request: &ImportHistorySession,
    ) -> Result<HistorySessionImported> {
        let session = scan
            .sessions
            .into_iter()
            .find(|session| {
                session.engine == request.engine && session.session_id == request.session_id
            })
            .ok_or_else(|| CoreError::NotFound("history session".into()))?;
        let Some(project_id) = session.project_id.as_deref() else {
            return Err(CoreError::Invalid(
                "Add the session's folder as a project first.".into(),
            ));
        };
        if !session.importable {
            return Err(CoreError::Invalid(
                "Trust the session's project before importing it.".into(),
            ));
        }
        self.check_engine_enabled(&session.engine, project_id)?;
        let project = self.store.project(project_id)?;
        let (thread, imported) = self.store.import_native_thread(
            NewThread {
                project_id: project.id.clone(),
                title: session.title,
                engine: session.engine.clone(),
                model: None,
                cwd: project.path.clone(),
                worktree: None,
                skill_profile: None,
                parent_thread_id: None,
                relation: None,
                scratch: false,
            },
            &session.session_id,
            &[],
        )?;
        Ok(HistorySessionImported {
            thread_id: thread.id,
            imported,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CoreConfig, store::NewProject, testing::TempDir};

    #[test]
    fn the_count_takes_every_conversation_file_and_no_subagent_transcript() {
        let dir = TempDir::new();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::create_dir_all(root.join("a/s1/subagents")).unwrap();
        std::fs::write(root.join("a/one.jsonl"), "").unwrap();
        std::fs::write(root.join("a/b/two.jsonl"), "").unwrap();
        std::fs::write(root.join("a/notes.txt"), "").unwrap();
        std::fs::write(root.join("a/s1/subagents/side.jsonl"), "").unwrap();
        assert_eq!(count_history_files(root), (2, false));
    }

    fn core(dir: &TempDir) -> Core {
        let mut config = CoreConfig::new(dir.path().join("data"), "http://127.0.0.1:1".into());
        config.engines.lookup_latest = false;
        Core::open(config).unwrap()
    }

    fn write(path: &Path, lines: &[Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text: Vec<String> = lines.iter().map(Value::to_string).collect();
        std::fs::write(path, text.join("\n")).unwrap();
    }

    #[test]
    fn reads_only_ids_folders_and_first_prompts_and_imports_into_trusted_projects() {
        use serde_json::json;
        let dir = TempDir::new();
        let core = core(&dir);
        let folder = dir.path().join("work");
        std::fs::create_dir_all(&folder).unwrap();
        let cwd = folder.to_str().unwrap().to_owned();
        // Absolute on every platform; a bare `/x` has no drive on Windows.
        let elsewhere = dir.path().join("elsewhere").to_str().unwrap().to_owned();
        let claude = dir.path().join("claude");
        let codex = dir.path().join("codex");
        write(
            &claude.join("-work").join("c1.jsonl"),
            &[
                json!({"type": "summary", "summary": "ignored"}),
                json!({"type": "user", "sessionId": "c1", "cwd": cwd,
                    "message": {"role": "user", "content": [{"type": "text", "text": "Fix   the\nlogin bug"}]}}),
                json!({"type": "assistant", "message": {"content": "PRIVATE_SENTINEL"}}),
            ],
        );
        write(
            &codex.join("2026/11/06").join("rollout-x.jsonl"),
            &[
                json!({"type": "session_meta", "payload": {"id": "k1", "cwd": elsewhere}}),
                json!({"type": "event_msg", "payload": {"type": "user_message", "message": "<environment>"}}),
                json!({"type": "event_msg", "payload": {"type": "user_message", "message": "Add tests"}}),
            ],
        );
        write(
            &claude.join("bad").join("b.jsonl"),
            &[json!({"sessionId": "../x", "cwd": cwd})],
        );
        let subagent = json!({"type": "user", "sessionId": "c1", "cwd": cwd, "isSidechain": true,
            "message": {"role": "user", "content": "Subagent brief"}});
        write(
            &claude
                .join("-work")
                .join("c1")
                .join("subagents")
                .join("agent-1.jsonl"),
            std::slice::from_ref(&subagent),
        );
        write(&claude.join("-work").join("side.jsonl"), &[subagent]);
        // A second file of the same session lists once.
        write(
            &claude.join("-copy").join("c1.jsonl"),
            &[
                json!({"type": "user", "sessionId": "c1", "cwd": cwd, "message": {"content": "Fix the login bug"}}),
            ],
        );
        let roots = [(Engine::Claude, Some(claude)), (Engine::Codex, Some(codex))];
        let scan = core.scan_history_in(&roots).unwrap();
        assert_eq!(
            scan.sessions.len(),
            2,
            "unsafe ids, subagents and repeats are skipped"
        );
        assert!(!format!("{scan:?}").contains("Subagent brief"));
        let by_id = |id: &str| {
            scan.sessions
                .iter()
                .find(|s| s.session_id == id)
                .unwrap()
                .clone()
        };
        assert_eq!(by_id("c1").title, "Fix the login bug");
        assert_eq!(by_id("k1").title, "Add tests");
        assert!(by_id("c1").project_id.is_none());
        assert!(!format!("{scan:?}").contains("PRIVATE_SENTINEL"));

        let project = core
            .store
            .add_project(NewProject {
                path: &cwd,
                name: "work",
                is_git: false,
                managed: false,
                scratch: false,
            })
            .unwrap();
        let request = ImportHistorySession {
            engine: "claude".into(),
            session_id: "c1".into(),
        };
        let scan = core.scan_history_in(&roots).unwrap();
        let untrusted = core.import_from(scan, &request).unwrap_err();
        assert!(untrusted.to_string().contains("Trust"), "{untrusted}");
        core.store.trust_project(&project.id, "test").unwrap();
        let first = core
            .import_from(core.scan_history_in(&roots).unwrap(), &request)
            .unwrap();
        assert!(first.imported);
        let again = core
            .import_from(core.scan_history_in(&roots).unwrap(), &request)
            .unwrap();
        assert_eq!(
            (again.thread_id.as_str(), again.imported),
            (first.thread_id.as_str(), false)
        );
        let thread = core.store.thread(&first.thread_id).unwrap();
        assert_eq!(thread.title, "Fix the login bug");
        assert_eq!(thread.engine, "claude");
        let scan = core.scan_history_in(&roots).unwrap();
        assert_eq!(
            by_id_in(&scan, "c1").thread_id.as_deref(),
            Some(first.thread_id.as_str())
        );
        let missing = ImportHistorySession {
            engine: "codex".into(),
            session_id: "nope".into(),
        };
        assert!(matches!(
            core.import_from(scan, &missing),
            Err(CoreError::NotFound(_))
        ));
    }

    fn by_id_in(scan: &HistoryScan, id: &str) -> HistorySession {
        scan.sessions
            .iter()
            .find(|s| s.session_id == id)
            .unwrap()
            .clone()
    }
}
