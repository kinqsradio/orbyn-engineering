//! The team's project file, `orbyn.json` at the checkout's root, or `t3.json` when
//! a repository already has one. Orbyn only ever reads it, and a script from it runs
//! only in a trusted folder because a person or a trusted thread asked.

use std::path::Path;

use orbyn_contracts::{ProjectFile, ProjectFileView, ProjectScript, TerminalInfo};
use serde_json::{Value, json};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::AuditRecord;
use crate::terminal::{PtySpec, TerminalLabel, shell_command};

const FILE_NAMES: [&str; 2] = ["orbyn.json", "t3.json"];
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_SCRIPTS: usize = 50;

/// Reads the first file present. A bad file is reported and never half-applied.
pub fn read_project_file(checkout: &Path) -> ProjectFileView {
    let Some(name) = FILE_NAMES.iter().find(|name| checkout.join(name).is_file()) else {
        return ProjectFileView {
            path: None,
            file: None,
            problem: None,
        };
    };
    let parsed = parse_file(&checkout.join(name));
    let (file, problem) = match parsed {
        Ok(file) => (Some(file), None),
        Err(problem) => (None, Some(problem)),
    };
    ProjectFileView {
        path: Some((*name).to_owned()),
        file,
        problem,
    }
}

fn parse_file(path: &Path) -> std::result::Result<ProjectFile, String> {
    let size = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_FILE_BYTES {
        return Err("This file is too large to read.".to_owned());
    }
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("This file is not valid: {error}"))?;
    let mut file: ProjectFile = serde_json::from_value(snake_keys(value))
        .map_err(|error| format!("This file is not valid: {error}"))?;
    if let Some(mode) = file.worktree_submodules.as_mut() {
        *mode = crate::preferences::submodule_mode(mode).to_owned();
    }
    if file
        .default_thread_env_mode
        .as_deref()
        .is_some_and(|mode| !["local", "worktree"].contains(&mode))
    {
        return Err("defaultThreadEnvMode must be local or worktree.".into());
    }
    if file
        .worktree_submodules
        .as_deref()
        .is_some_and(|mode| !["recursive", "top-level", "none"].contains(&mode))
    {
        return Err("worktreeSubmodules must be recursive, top-level or none.".into());
    }
    if file.scripts.len() > MAX_SCRIPTS {
        return Err(format!("A project file can hold {MAX_SCRIPTS} scripts."));
    }
    if file
        .scripts
        .iter()
        .any(|script| script.name.trim().is_empty() || script.command.trim().is_empty())
    {
        return Err("Every script needs a name and a command.".to_owned());
    }
    Ok(file)
}

/// The file is written in camelCase and the wire types are snake_case.
fn snake_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let mut snake = String::with_capacity(key.len());
                    for c in key.chars() {
                        if c.is_ascii_uppercase() {
                            snake.push('_');
                            snake.push(c.to_ascii_lowercase());
                        } else {
                            snake.push(c);
                        }
                    }
                    (snake, snake_keys(value))
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(snake_keys).collect()),
        other => other,
    }
}

/// A script's terminal id: its name, lowercased, in plain characters.
fn script_terminal(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("script-{slug}")
}

impl Core {
    pub fn project_file(&self, thread_id: &str) -> Result<ProjectFileView> {
        let thread = self.store.thread(thread_id)?;
        Ok(read_project_file(Path::new(&thread.cwd)))
    }

    fn start_script(
        &self,
        thread_id: &str,
        cwd: &str,
        script: &ProjectScript,
        actor: &str,
    ) -> Result<TerminalInfo> {
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: "script.run".into(),
            target: script.command.clone(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: None,
            detail: json!({ "name": script.name }),
        })?;
        let (program, args) = shell_command(&script.command);
        self.terminals.open_named(
            thread_id,
            &script_terminal(&script.name),
            TerminalLabel {
                title: Some(script.name.clone()),
                script: Some(script.name.clone()),
                ..TerminalLabel::default()
            },
            PtySpec {
                program,
                args,
                cwd: cwd.into(),
                cols: 120,
                rows: 32,
            },
        )
    }

    /// Runs a script from the checkout's project file in its own terminal. The
    /// command comes from the file, never from the request.
    pub fn run_script(&self, thread_id: &str, name: &str, actor: &str) -> Result<TerminalInfo> {
        let thread = self.store.thread(thread_id)?;
        if !self.store.project(&thread.project_id)?.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let view = read_project_file(Path::new(&thread.cwd));
        if let Some(problem) = view.problem {
            return Err(CoreError::Invalid(problem));
        }
        let script = view
            .file
            .into_iter()
            .flat_map(|file| file.scripts)
            .find(|script| script.name == name)
            .ok_or_else(|| CoreError::NotFound("script".into()))?;
        self.start_script(thread_id, &thread.cwd, &script, actor)
    }

    /// Runs the scripts a moment asks for, in a worktree only. One that cannot
    /// start is logged and does not stop the thread's own change.
    pub(crate) fn run_hook_scripts(
        &self,
        thread_id: &str,
        select: impl Fn(&ProjectScript) -> bool,
    ) {
        let Ok(thread) = self.store.thread(thread_id) else {
            return;
        };
        let trusted = self
            .store
            .project(&thread.project_id)
            .is_ok_and(|project| project.trusted);
        if thread.worktree.is_none() || !trusted {
            return;
        }
        let scripts = read_project_file(Path::new(&thread.cwd))
            .file
            .map(|file| file.scripts)
            .unwrap_or_default();
        for script in scripts.iter().filter(|script| select(script)) {
            if let Err(error) = self.start_script(thread_id, &thread.cwd, script, "system:script") {
                tracing::warn!(%error, "could not run a project script");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_is_read_leniently_and_a_bad_one_is_reported() {
        let dir = std::env::temp_dir().join(crate::util::new_id());
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_project_file(&dir).path, None);
        std::fs::write(
            dir.join("t3.json"),
            r#"{"$schema":"x","worktreeSubmodules":"skip","scripts":[
                {"name":"Dev","command":"npm run dev","runOnSettle":true,"previewUrl":"http://l"}
            ]}"#,
        )
        .unwrap();
        let view = read_project_file(&dir);
        assert_eq!(view.path.as_deref(), Some("t3.json"));
        let file = view.file.unwrap();
        assert_eq!(file.worktree_submodules.as_deref(), Some("none"));
        assert!(file.scripts[0].run_on_settle);
        std::fs::write(dir.join("orbyn.json"), "{ nope").unwrap();
        let view = read_project_file(&dir);
        assert_eq!(
            view.path.as_deref(),
            Some("orbyn.json"),
            "our own name wins"
        );
        assert!(view.file.is_none());
        assert!(view.problem.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn script_ids_stay_plain() {
        assert_eq!(script_terminal("Dev Server!"), "script-dev-server-");
    }
}
