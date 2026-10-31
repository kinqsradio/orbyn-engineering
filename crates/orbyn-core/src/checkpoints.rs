//! Diffs over checkpoints, and moving a thread back: restoring files, rewinding
//! the conversation, forking it and switching engines. An engine session cannot
//! follow any of these, so each one leaves a budgeted handoff for the next run.

use std::path::Path;

use orbyn_contracts::{
    CommitInfo, FileDiff, ForkThread, RestorePoint, RestoreWorkspace, RewindThread, SwitchEngine,
    Thread,
};
use orbyn_contracts::{ModelSelection, RunChanges};
use serde_json::{Value, json};

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::git;
use crate::store::AuditRecord;
use crate::util::new_id;

pub fn checkpoint_ref(thread_id: &str, run_id: &str, point: &str) -> String {
    format!("refs/orbyn/checkpoints/{thread_id}/{run_id}/{point}")
}

const MAX_CHANGED_PATHS: usize = 200;

/// Paths a raw engine item says were written: Codex's `fileChange` and Claude's own
/// file tools.
fn reported_paths(kind: &str, raw: &Value) -> Vec<String> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    match kind {
        "fileChange" => raw
            .get("changes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|change| text(change.get("path")))
            .collect(),
        "tool_use" => match raw.get("name").and_then(Value::as_str) {
            Some("Write" | "Edit" | "MultiEdit") => {
                text(raw.pointer("/input/file_path")).into_iter().collect()
            }
            Some("NotebookEdit") => text(raw.pointer("/input/notebook_path"))
                .into_iter()
                .collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

impl Core {
    fn trusted_thread(&self, id: &str) -> Result<Thread> {
        let thread = self.store.thread(id)?;
        if !self.store.project(&thread.project_id)?.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        Ok(thread)
    }

    fn idle_thread(&self, id: &str) -> Result<Thread> {
        let thread = self.trusted_thread(id)?;
        if thread.active_run.is_some() {
            return Err(CoreError::ThreadBusy);
        }
        Ok(thread)
    }

    fn scratch_index(&self) -> Result<std::path::PathBuf> {
        let dir = self.config.data_dir.join("runs");
        std::fs::create_dir_all(&dir)?;
        Ok(dir.join(format!("index-{}", new_id())))
    }

    fn thread_checkpoint(
        &self,
        thread_id: &str,
        run_id: &str,
    ) -> Result<orbyn_contracts::Checkpoint> {
        self.store
            .checkpoints(thread_id)?
            .into_iter()
            .find(|checkpoint| checkpoint.run_id == run_id)
            .ok_or_else(|| CoreError::NotFound("checkpoint".into()))
    }

    pub async fn turn_diff(&self, thread_id: &str, run_id: &str) -> Result<Vec<FileDiff>> {
        let thread = self.trusted_thread(thread_id)?;
        let checkpoint = self.thread_checkpoint(thread_id, run_id)?;
        let end = checkpoint
            .end
            .ok_or_else(|| CoreError::Invalid("This turn is still running.".into()))?;
        git::diff_between(Path::new(&thread.cwd), &checkpoint.start, &end).await
    }

    /// Everything the thread has changed, up to the files as they are now.
    pub async fn full_thread_diff(&self, thread_id: &str) -> Result<Vec<FileDiff>> {
        let thread = self.trusted_thread(thread_id)?;
        let Some(first) = self.store.checkpoints(thread_id)?.into_iter().next() else {
            return Ok(Vec::new());
        };
        let cwd = Path::new(&thread.cwd);
        let now = git::snapshot(cwd, None, &self.scratch_index()?).await?;
        git::diff_between(cwd, &first.start, &now).await
    }

    pub async fn branch_diff(&self, thread_id: &str, base: &str) -> Result<Vec<FileDiff>> {
        let thread = self.trusted_thread(thread_id)?;
        git::branch_diff(Path::new(&thread.cwd), base).await
    }

    pub async fn commit_diff(&self, thread_id: &str, sha: &str) -> Result<Vec<FileDiff>> {
        let thread = self.trusted_thread(thread_id)?;
        git::commit_diff(Path::new(&thread.cwd), sha).await
    }

    pub async fn thread_commits(&self, thread_id: &str) -> Result<Vec<CommitInfo>> {
        let thread = self.trusted_thread(thread_id)?;
        git::recent_commits(Path::new(&thread.cwd), 100).await
    }

    /// Puts the files back. Refused while another live thread shares the folder,
    /// since its work would be overwritten without its knowledge. The files as
    /// they stood are kept in a checkpoint ref first, so this can be undone.
    pub async fn restore_workspace(
        &self,
        thread_id: &str,
        request: &RestoreWorkspace,
        actor: &str,
    ) -> Result<()> {
        let thread = self.idle_thread(thread_id)?;
        let shared = self.store.threads_sharing_checkout(&thread)?;
        if !shared.is_empty() {
            return Err(CoreError::SharedDirectory(shared.len()));
        }
        let checkpoint = self.thread_checkpoint(thread_id, &request.run_id)?;
        let target = match request.point {
            RestorePoint::Start => checkpoint.start,
            RestorePoint::End => checkpoint
                .end
                .ok_or_else(|| CoreError::Invalid("This turn never finished.".into()))?,
        };
        let cwd = Path::new(&thread.cwd);
        let safety = checkpoint_ref(thread_id, &new_id(), "before-restore");
        let current = git::snapshot(cwd, Some(&safety), &self.scratch_index()?).await?;
        self.audit_thread(
            actor,
            "workspace.restore",
            thread_id,
            json!({
                "target": target,
                "safety": current,
            }),
        )?;
        git::restore_worktree(cwd, &current, &target).await
    }

    fn audit_thread(
        &self,
        actor: &str,
        action: &str,
        thread_id: &str,
        detail: serde_json::Value,
    ) -> Result<()> {
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: action.to_owned(),
            target: thread_id.to_owned(),
            decision: None,
            source: "user".into(),
            thread_id: Some(thread_id.to_owned()),
            run_id: None,
            detail,
        })?;
        Ok(())
    }

    /// Continues the conversation from before a run. The log stays whole, since
    /// it is append-only; clients hide what follows the logged rewind.
    pub async fn rewind_thread(
        &self,
        thread_id: &str,
        request: &RewindThread,
        actor: &str,
    ) -> Result<()> {
        self.idle_thread(thread_id)?;
        let through = self.store.seq_before_run(thread_id, &request.run_id)?;
        if request.restore_files {
            let restore = RestoreWorkspace {
                run_id: request.run_id.clone(),
                point: RestorePoint::Start,
            };
            self.restore_workspace(thread_id, &restore, actor).await?;
        }
        let handoff = self.store.handoff_text(thread_id, through)?;
        self.audit_thread(
            actor,
            "thread.rewind",
            thread_id,
            json!({ "through": through }),
        )?;
        self.store.set_handoff(thread_id, &handoff)?;
        self.store.forget_messages_after(thread_id, through)?;
        self.store
            .note_thread_event(thread_id, "thread.rewound", json!({ "through": through }))
    }

    pub fn fork_thread(&self, id: &str, request: &ForkThread, actor: &str) -> Result<Thread> {
        let parent = self.store.thread(id)?;
        if parent.active_run.is_some() && request.run_id.is_none() {
            return Err(CoreError::ThreadBusy);
        }
        let through = match &request.run_id {
            Some(run) => self.store.last_seq_of_run(id, run)?,
            None => self.store.latest_seq(id)?,
        };
        let title = request
            .title
            .clone()
            .unwrap_or_else(|| format!("Fork of {}", parent.title));
        self.audit_thread(actor, "thread.fork", id, json!({ "through": through }))?;
        self.store.fork_thread(&parent, through, &title)
    }

    /// The files this run's engine reported writing, from its stored items.
    pub fn run_changes(&self, id: &str, run_id: &str) -> Result<RunChanges> {
        let run = self.store.run(run_id)?;
        if run.thread_id != id {
            return Err(CoreError::NotFound("run".into()));
        }
        let items = self.store.run_items(id, run_id)?;
        let mut paths: Vec<String> = Vec::new();
        for item in &items {
            for path in reported_paths(&item.kind, &item.raw) {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        let truncated = paths.len() > MAX_CHANGED_PATHS;
        paths.truncate(MAX_CHANGED_PATHS);
        Ok(RunChanges {
            run_id: run_id.to_owned(),
            paths,
            truncated,
        })
    }

    /// Moves a thread to another engine with a budgeted summary of the conversation.
    pub fn switch_engine(&self, id: &str, request: &SwitchEngine, actor: &str) -> Result<Thread> {
        let thread = self.store.thread(id)?;
        if thread.active_run.is_some() {
            return Err(CoreError::ThreadBusy);
        }
        self.engines.driver(&request.engine)?;
        let through = self.store.latest_seq(id)?;
        let handoff = self.store.handoff_text(id, through)?;
        self.audit_thread(
            actor,
            "thread.switch_engine",
            id,
            json!({
                "from": thread.engine,
                "to": request.engine,
            }),
        )?;
        // What was asked for, then what was last chosen on that engine, then its
        // defaults. Admission checks the result, as it does any selection.
        let last = if request.engine == thread.engine {
            crate::selection::of_thread(&thread)
        } else {
            self.store.remembered_selection(&request.engine)?
        };
        let chosen = crate::selection::merged(
            &last,
            &ModelSelection {
                model: request.model.clone(),
                effort: request.effort.clone(),
                options: request.options.clone(),
            },
        );
        self.store
            .switch_thread_engine(id, &request.engine, &chosen, &handoff)?;
        self.store.thread(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_an_engine_reports_writing_counts() {
        let codex = json!({ "changes": [{ "path": "a.rs" }, { "path": "b.rs" }] });
        assert_eq!(reported_paths("fileChange", &codex), ["a.rs", "b.rs"]);
        let edit = json!({ "name": "Edit", "input": { "file_path": "/w/a.rs" } });
        assert_eq!(reported_paths("tool_use", &edit), ["/w/a.rs"]);
        let read = json!({ "name": "Read", "input": { "file_path": "/w/a.rs" } });
        assert!(reported_paths("tool_use", &read).is_empty());
        let bash = json!({ "name": "Bash", "input": { "command": "echo > x" } });
        assert!(reported_paths("tool_use", &bash).is_empty());
        assert!(reported_paths("commandExecution", &json!({})).is_empty());
    }
}
