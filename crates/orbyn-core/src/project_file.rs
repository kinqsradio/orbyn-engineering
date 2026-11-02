//! The team's project file, `orbyn.json` at the checkout's root, or `t3.json` when
//! a repository already has one. Orbyn only ever reads it, and a script from it runs
//! only in a trusted folder because a person or a trusted thread asked.

use std::io::Read;
use std::path::Path;

use orbyn_contracts::{ProjectFile, ProjectFileView, ProjectScript, TerminalInfo, Thread};
use serde_json::{Value, json};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::store::AuditRecord;
use crate::terminal::{PtySpec, TerminalLabel, shell_command};

pub(crate) const FILE_NAMES: [&str; 2] = ["orbyn.json", "t3.json"];
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_SCRIPTS: usize = 50;

/// The settings API and project files share the same executable script shape.
pub(crate) fn validate_scripts(value: &Value) -> Result<Vec<ProjectScript>> {
    let mut scripts: Vec<ProjectScript> = serde_json::from_value(value.clone())
        .map_err(|error| CoreError::Invalid(format!("Invalid project scripts: {error}")))?;
    assign_script_ids(&mut scripts);
    check_scripts(&scripts).map_err(CoreError::Invalid)?;
    Ok(scripts)
}

fn check_scripts(scripts: &[ProjectScript]) -> std::result::Result<(), String> {
    if scripts.len() > MAX_SCRIPTS {
        return Err(format!("A project can hold {MAX_SCRIPTS} scripts."));
    }
    let mut names = std::collections::BTreeSet::new();
    let mut ids = std::collections::BTreeSet::new();
    for script in scripts {
        if script.name.trim().is_empty() || script.command.trim().is_empty() {
            return Err("Every script needs a name and a command.".into());
        }
        if !names.insert(script.name.as_str()) {
            return Err("Each script needs a different name.".into());
        }
        if let Some(id) = &script.id {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err(
                    "Action IDs must be 1 to 128 letters, digits, hyphens or underscores.".into(),
                );
            }
            if !ids.insert(id.as_str()) {
                return Err("Each action needs a different ID.".into());
            }
        }
    }
    Ok(())
}

/// Legacy lists remain read-only; saving an action materializes this identity.
fn assign_script_ids(scripts: &mut [ProjectScript]) {
    for script in scripts {
        if script.id.is_none() {
            script.id = Some(format!(
                "action-{}",
                crate::util::sha256_hex(script.name.as_bytes())
            ));
        }
    }
}

/// Render effective identities while retaining the raw layers for revision fencing.
pub(crate) fn scripts_with_ids(value: &Value) -> Result<Value> {
    let scripts = validate_scripts(value)?;
    let mut display = value.clone();
    for (entry, script) in display
        .as_array_mut()
        .expect("validated list")
        .iter_mut()
        .zip(scripts)
    {
        entry["id"] = serde_json::to_value(script.id)?;
    }
    Ok(display)
}

/// Reads the first file present. A bad file is reported and never half-applied.
pub fn read_project_file(checkout: &Path) -> ProjectFileView {
    let root = match crate::util::canonicalize(checkout) {
        Ok(root) => root,
        Err(_) => {
            return ProjectFileView {
                path: None,
                file: None,
                problem: None,
                scripts: Vec::new(),
            };
        }
    };
    if root != checkout {
        return ProjectFileView {
            path: None,
            file: None,
            problem: Some("This project checkout is no longer at its registered path.".into()),
            scripts: Vec::new(),
        };
    }
    let Some(name) = FILE_NAMES.iter().find(|name| {
        // A directory is not a project file; aliases are present but invalid.
        std::fs::symlink_metadata(root.join(name)).is_ok_and(|metadata| !metadata.is_dir())
    }) else {
        return ProjectFileView {
            path: None,
            file: None,
            problem: None,
            scripts: Vec::new(),
        };
    };
    let parsed = parse_file(&root.join(name));
    let (file, problem) = match parsed {
        Ok(file) => (Some(file), None),
        Err(problem) => (None, Some(problem)),
    };
    ProjectFileView {
        path: Some((*name).to_owned()),
        scripts: file
            .as_ref()
            .map(|file| file.scripts.clone())
            .unwrap_or_default(),
        file,
        problem,
    }
}

fn parse_file(path: &Path) -> std::result::Result<ProjectFile, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // NONBLOCK also prevents a file-to-FIFO race from blocking this reader.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    let verify = |file: &std::fs::File| -> std::result::Result<(), String> {
        let actual = crate::files::opened_path(file).map_err(|error| error.to_string())?;
        if actual != path {
            return Err("This project file must be a direct file in the checkout.".into());
        }
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("This project file must be a regular file.".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("This project file must not be a reparse point.".into());
            }
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err("This file is too large to read.".into());
        }
        Ok(())
    };
    // Handle identity, not a prior path check, authorizes reading any bytes.
    verify(&file)?;
    let bytes = bounded_project_read(&mut file)?;
    verify(&file)?;
    let text = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    parse_project_text(&text)
}

fn bounded_project_read(reader: &mut impl Read) -> std::result::Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("This file is too large to read.".into());
    }
    Ok(bytes)
}

/// Decode text already read under the caller's path and byte-limit boundary.
pub(crate) fn parse_project_text(text: &str) -> std::result::Result<ProjectFile, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("This file is not valid: {error}"))?;
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
    assign_script_ids(&mut file.scripts);
    check_scripts(&file.scripts)?;
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

/// Manual action terminals follow identity, independently of display names.
fn script_terminal(script: &ProjectScript) -> String {
    format!(
        "script-{}",
        script
            .id
            .as_deref()
            .expect("validated actions have identities")
    )
}

impl Core {
    pub fn project_file(&self, thread_id: &str) -> Result<ProjectFileView> {
        let thread = self.store.thread(thread_id)?;
        self.project_file_at(&thread.project_id, Path::new(&thread.cwd))
    }

    pub(crate) fn project_file_at(&self, project_id: &str, cwd: &Path) -> Result<ProjectFileView> {
        let mut view = read_project_file(cwd);
        if view.problem.is_none() {
            let preferences = crate::preferences::stored_preferences_from_file(
                &self.store,
                Some(project_id),
                Some(&view),
            )?;
            let value = &preferences
                .iter()
                .find(|row| row.key == "default_project_scripts")
                .expect("fixed preference catalog includes project scripts")
                .value;
            view.scripts = validate_scripts(value)?;
        }
        Ok(view)
    }

    fn start_script(
        &self,
        thread_id: &str,
        cwd: &str,
        script: &ProjectScript,
        actor: &str,
        terminal_id: &str,
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
            terminal_id,
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

    pub(crate) fn start_setup_script(&self, thread: &Thread, script: &ProjectScript) -> Result<()> {
        if !self.store.project(&thread.project_id)?.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        // Each attempt has its own terminal identity. An exit notification from
        // an older process can never finish a newer preparation attempt.
        let id = format!("setup-{}", crate::util::new_id());
        let result = self.setups.launch(&thread.id, || {
            let made = self.start_script(&thread.id, &thread.cwd, script, "system:script", &id)?;
            let session = self
                .terminals
                .named(&thread.id, &made.id)
                .ok_or_else(|| CoreError::NotFound("setup terminal".into()))?;
            Ok((made.id, session))
        });
        if let Err(error) = result {
            if self.terminals.named(&thread.id, &id).is_some() {
                let _ = self.terminals.close_one(&thread.id, &id);
            }
            return Err(error);
        }
        Ok(())
    }

    /// Runs an effective project script in its own terminal. The request names
    /// a saved script; it never supplies a command.
    pub fn run_script(&self, thread_id: &str, name: &str, actor: &str) -> Result<TerminalInfo> {
        self.run_selected_script(thread_id, name, false, actor)
    }

    pub fn run_script_by_id(&self, thread_id: &str, id: &str, actor: &str) -> Result<TerminalInfo> {
        self.run_selected_script(thread_id, id, true, actor)
    }

    fn run_selected_script(
        &self,
        thread_id: &str,
        selector: &str,
        by_id: bool,
        actor: &str,
    ) -> Result<TerminalInfo> {
        let thread = self.store.thread(thread_id)?;
        if !self.store.project(&thread.project_id)?.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let view = self.project_file(thread_id)?;
        if let Some(problem) = view.problem {
            return Err(CoreError::Invalid(problem));
        }
        let script = view
            .scripts
            .into_iter()
            .find(|script| {
                if by_id {
                    script.id.as_deref() == Some(selector)
                } else {
                    script.name == selector
                }
            })
            .ok_or_else(|| CoreError::NotFound("script".into()))?;
        self.start_script(
            thread_id,
            &thread.cwd,
            &script,
            actor,
            &script_terminal(&script),
        )
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
        let view = match self.project_file(thread_id) {
            Ok(view) => view,
            Err(error) => {
                tracing::warn!(%error, "could not resolve project scripts");
                return;
            }
        };
        if let Some(problem) = view.problem {
            tracing::warn!(%problem, "could not read project scripts");
            return;
        }
        let scripts = view.scripts;
        if let Some(script) = scripts.iter().find(|script| select(script)) {
            let id = format!("settle-{}", crate::util::new_id());
            if let Err(error) =
                self.start_script(thread_id, &thread.cwd, script, "system:script", &id)
            {
                tracing::warn!(%error, "could not run a project script");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_file_precedence_bounds_and_directories_are_preserved() {
        let dir = std::env::temp_dir().join(crate::util::new_id());
        std::fs::create_dir_all(dir.join("orbyn.json")).unwrap();
        let dir = crate::util::canonicalize(&dir).unwrap();
        std::fs::write(
            dir.join("t3.json"),
            r#"{"defaultThreadEnvMode":"worktree","futureField":true}"#,
        )
        .unwrap();
        let view = read_project_file(&dir);
        assert_eq!(view.path.as_deref(), Some("t3.json"));
        assert_eq!(
            view.file.unwrap().default_thread_env_mode.as_deref(),
            Some("worktree")
        );
        std::fs::remove_dir(dir.join("orbyn.json")).unwrap();
        let mut exact = b"{}".to_vec();
        exact.resize(MAX_FILE_BYTES as usize, b' ');
        std::fs::write(dir.join("orbyn.json"), &exact).unwrap();
        let view = read_project_file(&dir);
        assert_eq!(view.path.as_deref(), Some("orbyn.json"));
        assert!(view.problem.is_none(), "{:?}", view.problem);
        exact.push(b' ');
        std::fs::write(dir.join("orbyn.json"), exact).unwrap();
        let view = read_project_file(&dir);
        assert_eq!(
            view.problem.as_deref(),
            Some("This file is too large to read.")
        );
        assert!(view.file.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_growing_source_is_probed_only_one_byte_past_the_limit() {
        struct Growing {
            bytes: usize,
        }
        impl Read for Growing {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                buffer.fill(b' ');
                self.bytes += buffer.len();
                Ok(buffer.len())
            }
        }
        let mut reader = Growing { bytes: 0 };
        assert_eq!(
            bounded_project_read(&mut reader).unwrap_err(),
            "This file is too large to read."
        );
        assert_eq!(reader.bytes as u64, MAX_FILE_BYTES + 1);
    }

    #[cfg(unix)]
    #[test]
    fn outside_and_in_checkout_project_file_aliases_are_rejected_without_fallback() {
        let dir = std::env::temp_dir().join(crate::util::new_id());
        let root = dir.join("checkout");
        std::fs::create_dir_all(&root).unwrap();
        let root = crate::util::canonicalize(&root).unwrap();
        std::fs::write(root.join("t3.json"), "{}").unwrap();
        for target in [dir.join("outside.json"), root.join("inside.json")] {
            std::fs::write(&target, r#"{"defaultThreadEnvMode":"worktree"}"#).unwrap();
            std::os::unix::fs::symlink(&target, root.join("orbyn.json")).unwrap();
            let view = read_project_file(&root);
            assert_eq!(view.path.as_deref(), Some("orbyn.json"));
            assert!(
                view.problem.is_some(),
                "aliased bytes must not become defaults"
            );
            assert!(view.file.is_none());
            assert!(view.scripts.is_empty());
            std::fs::remove_file(root.join("orbyn.json")).unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_parent_replaced_after_checkout_resolution_cannot_authorize_other_bytes() {
        let dir = std::env::temp_dir().join(crate::util::new_id());
        let root = dir.join("checkout");
        let outside = dir.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(
            outside.join("orbyn.json"),
            r#"{"defaultThreadEnvMode":"worktree"}"#,
        )
        .unwrap();
        let expected = crate::util::canonicalize(&root).unwrap().join("orbyn.json");
        std::fs::remove_dir(&root).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        let view = read_project_file(expected.parent().unwrap());
        assert!(view.problem.is_some());
        assert!(view.file.is_none());
        assert!(view.scripts.is_empty());

        assert_eq!(
            parse_file(&expected).unwrap_err(),
            "This project file must be a direct file in the checkout."
        );
        std::fs::remove_file(&root).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_file_is_read_leniently_and_a_bad_one_is_reported() {
        let dir = std::env::temp_dir().join(crate::util::new_id());
        std::fs::create_dir_all(&dir).unwrap();
        let dir = crate::util::canonicalize(&dir).unwrap();
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
        assert!(
            file.scripts[0].asynchronous,
            "Missing async keeps the reference default"
        );
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
        let actions = validate_scripts(
            &json!([{"id":"dev-server","name":"Dev Server!","command":"echo ready"}]),
        )
        .unwrap();
        assert_eq!(script_terminal(&actions[0]), "script-dev-server");
    }

    #[test]
    fn settings_scripts_require_executable_shapes_and_unique_names() {
        assert!(validate_scripts(&json!([])).is_ok());
        assert!(validate_scripts(&json!([{"name":"Dev","command":"echo ok"}])).is_ok());
        for value in [
            json!(["echo no"]),
            json!([{"name":"Dev","command":"  "}]),
            json!([{"name":"  ","command":"echo no"}]),
            json!([{"name":"Dev","command":"echo one"},{"name":"Dev","command":"echo two"}]),
            json!([{"name":"Dev","command":"echo no","run_on_settle":"yes"}]),
            json!([{"name":"Dev","command":"echo no","async":"false"}]),
            json!([{"id":"../escape","name":"Dev","command":"echo no"}]),
            json!([{"id":"","name":"Dev","command":"echo no"}]),
            json!([{"id":"same","name":"One","command":"echo one"},{"id":"same","name":"Two","command":"echo two"}]),
            json!([{"name":"Dev"}]),
        ] {
            assert!(validate_scripts(&value).is_err(), "{value}");
        }
    }

    #[test]
    fn legacy_action_identity_is_deterministic_and_does_not_collapse_names() {
        let source = json!([
            {"name":"Dev Server", "command":"echo first"},
            {"name":"Dev-Server", "command":"echo second"},
            {"id":"team-build", "name":"Build", "command":"echo third"}
        ]);
        let first = validate_scripts(&source).unwrap();
        let mut reversed = source.as_array().unwrap().clone();
        reversed.reverse();
        let second = validate_scripts(&Value::Array(reversed)).unwrap();
        assert_ne!(first[0].id, first[1].id);
        assert_eq!(first[0].id, second[2].id);
        assert_eq!(first[2].id.as_deref(), Some("team-build"));
        assert!(
            source[0].get("id").is_none(),
            "reading does not rewrite legacy data"
        );
    }
}
