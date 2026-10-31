//! Diffs over checkpoints, and moving a thread back: restoring files, rewinding
//! the conversation, forking it and switching engines. An engine session cannot
//! follow any of these, so each one leaves a budgeted handoff for the next run.

use std::path::Path;

use orbyn_contracts::ModelSelection;
use orbyn_contracts::{
    CommitInfo, FileDiff, ForkThread, RestorePoint, RestoreWorkspace, RewindThread, SwitchEngine,
    Thread,
};
use serde_json::json;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::git;
use crate::store::AuditRecord;
use crate::util::new_id;

pub fn checkpoint_ref(thread_id: &str, run_id: &str, point: &str) -> String {
    format!("refs/orbyn/checkpoints/{thread_id}/{run_id}/{point}")
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
