//! Source control on a thread's checkout. Forge work goes through the user's own
//! `gh` or `glab`, so their login stays theirs and Orbyn holds no credential. All
//! of it needs a trusted folder, and commit hooks do run here, as they would for
//! the user. Writes wait for the thread's run to finish.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use orbyn_contracts::{
    AddPullComment, BranchInfo, CheckoutPull, CreateBranch, EditPullComment, ForgeStatus,
    GitAction, GitActionResult, GitPhase, MergePull, Project, PublishProject, PullBulkResult,
    PullCandidate, PullCheck, PullCheckout, PullConversation, PullFile, PullList, PullListEntry,
    PullListFailure, PullRequest, PullRequestDetail, PullRequestDraft, PullRevision, PullStack,
    PullTimelineEvent, PullWatch, ReactPullComment, SetPullPeople, StackAction, SubmitReview,
    Thread, UpdatePull, WorkOnPull,
};
use serde_json::{Value, json};
use tokio::process::Command;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::forge::{
    self, ALL_FORGES, Forge, PullFilter, create_pull, fetch_pull, forge_of, number_from_url,
};
use crate::git::{git, text};
use crate::store::{AuditRecord, WatchUpdate};
use crate::util::tail;

const FORGE_TIMEOUT: Duration = Duration::from_secs(120);
const PUSH_TIMEOUT: Duration = Duration::from_secs(300);
/// Watching ends after this many wakes in a row that bring only comments.
const MAX_COMMENT_WAKES: i64 = 10;
/// Watching ends after this many failed reads in a row.
const MAX_WATCH_FAILURES: i64 = 8;

/// Runs git for a real user action: hooks stay on, and nothing may prompt.
pub(crate) async fn git_user(cwd: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::child_env::for_tool(command.as_std_mut());
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| CoreError::Git("Git did not finish in time.".into()))?
        .map_err(|error| CoreError::Git(format!("Could not run git: {error}")))?;
    if !output.status.success() {
        return Err(CoreError::Git(tail(
            &String::from_utf8_lossy(&output.stderr),
            1024,
        )));
    }
    Ok(text(&output.stdout))
}

fn phase(name: &str, outcome: Result<Option<String>>) -> GitPhase {
    match outcome {
        Ok(url) => GitPhase {
            name: name.to_owned(),
            ok: true,
            message: None,
            url,
        },
        Err(error) => GitPhase {
            name: name.to_owned(),
            ok: false,
            message: Some(error.public_message()),
            url: None,
        },
    }
}

async fn valid_branch(cwd: &Path, name: &str) -> Result<()> {
    git(cwd, &["check-ref-format", "--branch", name])
        .await
        .map(|_| ())
        .map_err(|_| CoreError::Invalid("That is not a valid branch name.".into()))
}

impl Core {
    fn scm_thread(&self, id: &str) -> Result<Thread> {
        let thread = self.store.thread(id)?;
        if !self.store.project(&thread.project_id)?.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        Ok(thread)
    }

    /// Git writes would race an engine in the same folder.
    fn scm_idle(&self, id: &str) -> Result<Thread> {
        let thread = self.scm_thread(id)?;
        if thread.active_run.is_some() {
            return Err(CoreError::ThreadBusy);
        }
        Ok(thread)
    }

    fn scm_audit(&self, actor: &str, action: &str, target: &str, id: Option<&str>) -> Result<()> {
        self.store.append_audit(&AuditRecord {
            actor: actor.to_owned(),
            action: action.to_owned(),
            target: target.to_owned(),
            decision: None,
            source: "user".into(),
            thread_id: id.map(str::to_owned),
            run_id: None,
            detail: Value::Null,
        })?;
        Ok(())
    }

    /// Commits, pushes and opens a pull request, stopping at the first failure.
    /// Each phase is logged, so a client can show progress as it happens.
    pub async fn git_action(
        &self,
        id: &str,
        action: &GitAction,
        actor: &str,
    ) -> Result<GitActionResult> {
        let thread = self.scm_idle(id)?;
        let cwd = Path::new(&thread.cwd);
        let mut phases = Vec::new();
        if let Some(message) = &action.commit_message {
            if message.trim().is_empty() {
                return Err(CoreError::Invalid("Enter a commit message.".into()));
            }
            self.scm_audit(actor, "git.commit", message, Some(id))?;
            let outcome = async {
                git_user(cwd, &["add", "-A"], FORGE_TIMEOUT).await?;
                git_user(cwd, &["commit", "-q", "-m", message], FORGE_TIMEOUT).await?;
                Ok(None)
            }
            .await;
            if !self.record_phase(id, &mut phases, phase("commit", outcome))? {
                return Ok(GitActionResult { phases });
            }
        }
        let branch = text(&git(cwd, &["branch", "--show-current"]).await?);
        if action.push {
            self.scm_audit(actor, "git.push", &branch, Some(id))?;
            let outcome = git_user(cwd, &["push", "-u", "origin", &branch], PUSH_TIMEOUT)
                .await
                .map(|_| None);
            if !self.record_phase(id, &mut phases, phase("push", outcome))? {
                return Ok(GitActionResult { phases });
            }
        }
        if let Some(draft) = &action.pull_request {
            self.scm_audit(actor, "git.pull_request", &draft.title, Some(id))?;
            let outcome = self.open_pull(id, cwd, &branch, draft).await.map(Some);
            self.record_phase(id, &mut phases, phase("pull_request", outcome))?;
        }
        Ok(GitActionResult { phases })
    }

    async fn open_pull(
        &self,
        id: &str,
        cwd: &Path,
        branch: &str,
        draft: &PullRequestDraft,
    ) -> Result<String> {
        let forge = forge_of(cwd).await?;
        let url = create_pull(
            forge,
            cwd,
            branch,
            &draft.title,
            &draft.body,
            draft.base.as_deref(),
        )
        .await?;
        // The pull request exists now; a failed lookup must not report otherwise.
        match number_from_url(&url) {
            Some(number) => {
                let pull = fetch_pull(forge, cwd, number).await.unwrap_or(PullRequest {
                    number,
                    title: draft.title.clone(),
                    url: url.clone(),
                    state: "open".into(),
                    head: branch.to_owned(),
                    base: draft.base.clone().unwrap_or_default(),
                    author: None,
                    draft: false,
                    updated_at: None,
                    labels: Vec::new(),
                    review_state: None,
                    checks_state: None,
                });
                self.store.link_pull(id, &pull)?;
            }
            None => tracing::warn!("the forge returned no pull request number"),
        }
        Ok(url)
    }

    fn record_phase(&self, id: &str, phases: &mut Vec<GitPhase>, phase: GitPhase) -> Result<bool> {
        let ok = phase.ok;
        self.store
            .note_thread_event(id, "git.phase", json!(phase))?;
        phases.push(phase);
        Ok(ok)
    }

    pub async fn branches(&self, id: &str) -> Result<Vec<BranchInfo>> {
        let thread = self.scm_thread(id)?;
        let cwd = Path::new(&thread.cwd);
        let current = text(&git(cwd, &["branch", "--show-current"]).await?);
        let refs = git(
            cwd,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads",
                "refs/remotes",
            ],
        )
        .await?;
        Ok(String::from_utf8_lossy(&refs)
            .lines()
            .filter(|name| !name.ends_with("/HEAD"))
            .filter_map(|name| {
                let (name, remote) = match name.strip_prefix("refs/heads/") {
                    Some(local) => (local, false),
                    None => (name.strip_prefix("refs/remotes/")?, true),
                };
                Some(BranchInfo {
                    current: !remote && name == current,
                    name: name.to_owned(),
                    remote,
                })
            })
            .collect())
    }

    pub async fn create_branch(&self, id: &str, request: &CreateBranch, actor: &str) -> Result<()> {
        let thread = self.scm_idle(id)?;
        let cwd = Path::new(&thread.cwd);
        valid_branch(cwd, &request.name).await?;
        self.scm_audit(actor, "git.branch", &request.name, Some(id))?;
        let mut args = vec!["switch", "-q", "-c", request.name.as_str()];
        if let Some(start) = &request.start {
            if start.starts_with('-') {
                return Err(CoreError::Invalid(
                    "That is not a valid start point.".into(),
                ));
            }
            args.push(start);
        }
        git_user(cwd, &args, FORGE_TIMEOUT).await.map(|_| ())
    }

    /// Git itself refuses a switch that would overwrite local changes.
    pub async fn switch_branch(&self, id: &str, name: &str, actor: &str) -> Result<()> {
        let thread = self.scm_idle(id)?;
        let cwd = Path::new(&thread.cwd);
        valid_branch(cwd, name).await?;
        self.scm_audit(actor, "git.switch", name, Some(id))?;
        git_user(cwd, &["switch", "-q", name], FORGE_TIMEOUT)
            .await
            .map(|_| ())
    }

    pub async fn link_pull(&self, id: &str, number: u64) -> Result<PullRequest> {
        let thread = self.scm_thread(id)?;
        let cwd = Path::new(&thread.cwd);
        let pull = fetch_pull(forge_of(cwd).await?, cwd, number).await?;
        self.store.link_pull(id, &pull)?;
        Ok(pull)
    }

    /// Reads each linked pull request again. A merge settles the thread when the
    /// rules say so; a thread still running or opted out stays as it is.
    pub async fn refresh_pulls(&self, id: &str) -> Result<Vec<PullRequest>> {
        let thread = self.scm_thread(id)?;
        let cwd = Path::new(&thread.cwd);
        let forge = forge_of(cwd).await?;
        self.link_branch_pull(id, forge, cwd).await;
        let mut merged = false;
        for pull in self.store.linked_pulls(id)? {
            if pull.state != "open" {
                continue;
            }
            let fresh = fetch_pull(forge, cwd, pull.number).await?;
            merged |= fresh.state == "merged";
            self.store.link_pull(id, &fresh)?;
        }
        let on_merge = self.preference("auto_settle_on_merge", Some(&thread.project_id))?
            == serde_json::json!(true);
        let opted_out = thread.lifecycle.as_ref().and_then(|l| l.auto_settle) == Some(false);
        if merged && on_merge && !opted_out && thread.active_run.is_none() {
            let settle = orbyn_contracts::UpdateThread {
                settled: Some(true),
                ..Default::default()
            };
            self.update_thread(id, &settle, "system:auto-settle")?;
        }
        self.store.linked_pulls(id)
    }

    /// Links the open pull request of the checkout's branch, if there is one.
    async fn link_branch_pull(&self, id: &str, forge: Forge, cwd: &Path) {
        let Ok(branch) = git(cwd, &["branch", "--show-current"]).await else {
            return;
        };
        let branch = text(&branch);
        if branch.is_empty() {
            return;
        }
        let filter = PullFilter {
            state: "open".into(),
            head: Some(branch),
            ..PullFilter::default()
        };
        let linked = self.store.linked_pulls(id).unwrap_or_default();
        if let Ok(pulls) = forge::list_pulls(forge, cwd, &filter).await
            && let Some(pull) = pulls.first()
            && pull.state == "open"
            && !linked.iter().any(|known| known.number == pull.number)
            && let Err(error) = self.store.link_pull(id, pull)
        {
            tracing::debug!(%error, "could not link the branch's pull request");
        }
    }

    /// One pass of the pull request watch. A failure waits for the next pass.
    pub async fn watch_pulls(&self) {
        let threads = self.store.threads_with_open_pulls().unwrap_or_default();
        for id in threads {
            if let Err(error) = self.refresh_pulls(&id).await {
                tracing::debug!(%error, "could not refresh a pull request");
            }
        }
        let watches = self.store.pull_watches(None).unwrap_or_default();
        for watch in watches {
            if let Err(error) = self.check_watch(&watch).await {
                tracing::debug!(%error, "could not check a watched pull request");
            }
        }
    }

    /// Reads a watched pull request and wakes the thread on news. A read that
    /// fails counts toward the stop rule and never wakes anyone.
    async fn check_watch(&self, watch: &crate::store::WatchRow) -> Result<()> {
        let number = watch.number;
        let thread = self.scm_thread(&watch.thread_id)?;
        let cwd = Path::new(&thread.cwd);
        let forge = forge_of(cwd).await?;
        let read = read_watch(forge, cwd, number).await;
        let (state, viewer) = match read {
            Ok(read) => read,
            Err(error) => {
                let failures = watch.failures + 1;
                if failures >= MAX_WATCH_FAILURES {
                    self.store.unwatch_pull(&watch.thread_id, number)?;
                } else {
                    self.store.update_watch(
                        &watch.thread_id,
                        number,
                        WatchUpdate::failed(failures),
                    )?;
                }
                return Err(error);
            }
        };
        if state.finished {
            self.store.unwatch_pull(&watch.thread_id, number)?;
            return Ok(());
        }
        let last = watch
            .snapshot
            .as_deref()
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or_default();
        let (news, comments_only) = watch_news(&last, &state, viewer.as_deref());
        let wakes = if news.is_empty() {
            watch.comment_wakes
        } else if comments_only {
            watch.comment_wakes + 1
        } else {
            0
        };
        self.store.update_watch(
            &watch.thread_id,
            number,
            WatchUpdate {
                snapshot: Some(serde_json::to_string(&state)?),
                comment_wakes: wakes,
                failures: 0,
            },
        )?;
        if !news.is_empty() {
            let prompt = format!(
                "Pull request #{number} changed while you were watching it:\n{}",
                news.join("\n")
            );
            self.runs.enqueue(&watch.thread_id, &prompt, &[])?;
        }
        if wakes >= MAX_COMMENT_WAKES {
            self.store.unwatch_pull(&watch.thread_id, number)?;
        }
        Ok(())
    }

    /// Starts watching. A pull request watched before keeps what it last reported.
    pub fn watch_pull(&self, id: &str, number: u64) -> Result<PullWatch> {
        let thread = self.scm_thread(id)?;
        let lifecycle = thread.lifecycle.as_ref();
        let parked = lifecycle.is_some_and(|l| l.settled_at.is_some() || l.archived_at.is_some());
        if parked {
            return Err(CoreError::Invalid(
                "Unsettle this thread before watching a pull request.".into(),
            ));
        }
        if lifecycle.is_some_and(|l| l.relation.as_deref() == Some("subagent")) {
            return Err(CoreError::Invalid(
                "The thread that delegated this work watches pull requests.".into(),
            ));
        }
        self.store.watch_pull(id, number)
    }

    pub fn thread_watches(&self, id: &str) -> Result<Vec<PullWatch>> {
        Ok(self
            .store
            .pull_watches(Some(id))?
            .into_iter()
            .map(|row| PullWatch {
                thread_id: row.thread_id,
                number: row.number,
                created_at: row.created_at,
            })
            .collect())
    }

    pub async fn pull_detail(&self, id: &str, number: u64) -> Result<PullRequestDetail> {
        let thread = self.scm_thread(id)?;
        let cwd = Path::new(&thread.cwd);
        forge::pull_detail(forge_of(cwd).await?, cwd, number).await
    }

    pub async fn review_pull(
        &self,
        id: &str,
        number: u64,
        review: &SubmitReview,
        actor: &str,
    ) -> Result<()> {
        let thread = self.scm_thread(id)?;
        let cwd = Path::new(&thread.cwd);
        let forge = forge_of(cwd).await?;
        self.scm_audit(actor, "git.review", &number.to_string(), Some(id))?;
        forge::submit_review(forge, cwd, number, review).await
    }

    pub async fn merge_pull(
        &self,
        id: &str,
        number: u64,
        options: &MergePull,
        actor: &str,
    ) -> Result<()> {
        let thread = self.scm_thread(id)?;
        let cwd = Path::new(&thread.cwd);
        let forge = forge_of(cwd).await?;
        self.scm_audit(actor, "git.merge", &number.to_string(), Some(id))?;
        forge::merge(forge, cwd, number, options).await?;
        self.refresh_pulls(id).await.map(|_| ())
    }

    /// A trusted project's folder and forge.
    async fn pull_site(&self, project_id: &str) -> Result<(Project, Forge)> {
        let project = self.store.project(project_id)?;
        if !project.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let forge = forge_of(Path::new(&project.path)).await?;
        Ok((project, forge))
    }

    pub async fn project_pulls(
        &self,
        project_id: &str,
        filter: &PullFilter,
    ) -> Result<Vec<PullRequest>> {
        check_state(&filter.state)?;
        let (project, forge) = self.pull_site(project_id).await?;
        forge::list_pulls(forge, Path::new(&project.path), filter).await
    }

    /// Pull requests across every trusted project with a remote. A project that
    /// cannot be read is named, so a partial list is never mistaken for a whole one.
    pub async fn all_pulls(&self, filter: &PullFilter) -> Result<PullList> {
        check_state(&filter.state)?;
        let mut list = PullList {
            pulls: Vec::new(),
            failed: Vec::new(),
        };
        for project in self.store.list_projects()? {
            if !project.trusted || !project.is_git {
                continue;
            }
            let cwd = PathBuf::from(&project.path);
            if git(&cwd, &["remote", "get-url", "origin"]).await.is_err() {
                continue;
            }
            match self.project_pulls(&project.id, filter).await {
                Ok(pulls) => list
                    .pulls
                    .extend(pulls.into_iter().map(|pull| PullListEntry {
                        project_id: project.id.clone(),
                        pull,
                    })),
                Err(error) => list.failed.push(PullListFailure {
                    project_id: project.id,
                    message: error.public_message(),
                }),
            }
        }
        Ok(list)
    }

    pub async fn project_pull(&self, project_id: &str, number: u64) -> Result<PullRequestDetail> {
        let (project, forge) = self.pull_site(project_id).await?;
        forge::pull_detail(forge, Path::new(&project.path), number).await
    }

    pub async fn pull_checks(&self, project_id: &str, number: u64) -> Result<Vec<PullCheck>> {
        let (project, forge) = self.pull_site(project_id).await?;
        forge::pull_checks(forge, Path::new(&project.path), number).await
    }

    pub async fn approve_workflow(&self, project_id: &str, run: u64, actor: &str) -> Result<()> {
        let (project, forge) = self.pull_site(project_id).await?;
        self.scm_audit(actor, "git.workflow_approve", &run.to_string(), None)?;
        forge::approve_workflow(forge, Path::new(&project.path), run).await
    }

    pub async fn pull_conversation(
        &self,
        project_id: &str,
        number: u64,
    ) -> Result<PullConversation> {
        let (project, forge) = self.pull_site(project_id).await?;
        forge::conversation(forge, Path::new(&project.path), number).await
    }

    pub async fn pull_timeline(
        &self,
        project_id: &str,
        number: u64,
    ) -> Result<Vec<PullTimelineEvent>> {
        let (project, forge) = self.pull_site(project_id).await?;
        forge::timeline(forge, Path::new(&project.path), number).await
    }

    /// Changed files, with this service's viewed marks.
    pub async fn pull_files(&self, project_id: &str, number: u64) -> Result<Vec<PullFile>> {
        let (project, forge) = self.pull_site(project_id).await?;
        let viewed = self.store.viewed_files(project_id, number)?;
        let mut files = forge::pull_files(forge, Path::new(&project.path), number).await?;
        for file in &mut files {
            file.viewed = viewed.contains(&file.path);
        }
        Ok(files)
    }

    pub async fn pull_revisions(&self, project_id: &str, number: u64) -> Result<Vec<PullRevision>> {
        let (project, forge) = self.pull_site(project_id).await?;
        forge::pull_revisions(forge, Path::new(&project.path), number).await
    }

    /// One commit's files. Viewed marks belong to the whole pull request, not a commit.
    pub async fn revision_files(&self, project_id: &str, sha: &str) -> Result<Vec<PullFile>> {
        let (project, forge) = self.pull_site(project_id).await?;
        forge::revision_files(forge, Path::new(&project.path), sha).await
    }

    pub async fn comment_pull(
        &self,
        project_id: &str,
        number: u64,
        request: &AddPullComment,
        actor: &str,
    ) -> Result<()> {
        if request.body.trim().is_empty() {
            return Err(CoreError::Invalid("Write a comment first.".into()));
        }
        let (project, forge) = self.pull_site(project_id).await?;
        self.scm_audit(actor, "git.pull_comment", &number.to_string(), None)?;
        forge::add_comment(forge, Path::new(&project.path), number, request).await
    }

    pub async fn edit_pull_comment(
        &self,
        project_id: &str,
        number: u64,
        comment: &str,
        request: &EditPullComment,
        actor: &str,
    ) -> Result<()> {
        check_opaque(comment)?;
        let (project, forge) = self.pull_site(project_id).await?;
        self.scm_audit(actor, "git.pull_comment_edit", comment, None)?;
        let cwd = Path::new(&project.path);
        forge::edit_comment(forge, cwd, number, comment, &request.kind, &request.body).await
    }

    pub async fn react_pull_comment(
        &self,
        project_id: &str,
        number: u64,
        comment: &str,
        request: &ReactPullComment,
    ) -> Result<()> {
        check_opaque(comment)?;
        let (project, forge) = self.pull_site(project_id).await?;
        let cwd = Path::new(&project.path);
        forge::react(forge, cwd, number, comment, &request.kind, &request.content).await
    }

    pub async fn resolve_pull_thread(
        &self,
        project_id: &str,
        number: u64,
        thread: &str,
        resolved: bool,
        actor: &str,
    ) -> Result<()> {
        check_opaque(thread)?;
        let (project, forge) = self.pull_site(project_id).await?;
        self.scm_audit(actor, "git.pull_thread_resolve", thread, None)?;
        let cwd = Path::new(&project.path);
        forge::set_thread_resolved(forge, cwd, number, thread, resolved).await
    }

    pub async fn submit_pull_review(
        &self,
        project_id: &str,
        number: u64,
        review: &SubmitReview,
        actor: &str,
    ) -> Result<()> {
        let (project, forge) = self.pull_site(project_id).await?;
        self.scm_audit(actor, "git.review", &number.to_string(), None)?;
        forge::submit_review(forge, Path::new(&project.path), number, review).await
    }

    pub async fn pull_reviewers(&self, project_id: &str) -> Result<Vec<PullCandidate>> {
        let (project, forge) = self.pull_site(project_id).await?;
        forge::reviewer_candidates(forge, Path::new(&project.path)).await
    }

    pub async fn pull_labels(&self, project_id: &str) -> Result<Vec<PullCandidate>> {
        let (project, forge) = self.pull_site(project_id).await?;
        forge::label_candidates(forge, Path::new(&project.path)).await
    }

    pub async fn set_pull_reviewers(
        &self,
        project_id: &str,
        number: u64,
        change: &SetPullPeople,
        actor: &str,
    ) -> Result<()> {
        let (project, forge) = self.pull_site(project_id).await?;
        self.scm_audit(actor, "git.pull_reviewers", &number.to_string(), None)?;
        forge::set_reviewers(forge, Path::new(&project.path), number, change).await
    }

    pub async fn set_pull_labels(
        &self,
        project_id: &str,
        number: u64,
        change: &SetPullPeople,
        actor: &str,
    ) -> Result<()> {
        let (project, forge) = self.pull_site(project_id).await?;
        self.scm_audit(actor, "git.pull_labels", &number.to_string(), None)?;
        forge::set_labels(forge, Path::new(&project.path), number, change).await
    }

    pub async fn update_pull(
        &self,
        project_id: &str,
        number: u64,
        update: &UpdatePull,
        actor: &str,
    ) -> Result<PullRequestDetail> {
        let (project, forge) = self.pull_site(project_id).await?;
        let cwd = Path::new(&project.path);
        self.scm_audit(actor, "git.pull_update", &number.to_string(), None)?;
        forge::update_pull(forge, cwd, number, update).await?;
        forge::pull_detail(forge, cwd, number).await
    }

    pub async fn merge_project_pull(
        &self,
        project_id: &str,
        number: u64,
        options: &MergePull,
        actor: &str,
    ) -> Result<()> {
        let (project, forge) = self.pull_site(project_id).await?;
        self.scm_audit(actor, "git.merge", &number.to_string(), None)?;
        let mut options = options.clone();
        options.strip_credits |=
            self.preference("remove_agent_credits_on_merge", Some(project_id))? == json!(true);
        forge::merge(forge, Path::new(&project.path), number, &options).await
    }

    pub async fn pull_action(
        &self,
        project_id: &str,
        number: u64,
        action: &str,
        actor: &str,
    ) -> Result<()> {
        let (project, forge) = self.pull_site(project_id).await?;
        let cwd = Path::new(&project.path);
        // Deleting a branch needs its name, and only then is it worth a read.
        let head = if action == "delete_branch" {
            fetch_pull(forge, cwd, number).await?.head
        } else {
            String::new()
        };
        self.scm_audit(
            actor,
            &format!("git.pull_{action}"),
            &number.to_string(),
            None,
        )?;
        forge::pull_action(forge, cwd, number, action, &head).await
    }

    /// Closes each in turn. One refusal does not stop the rest.
    pub async fn close_pulls(
        &self,
        project_id: &str,
        numbers: &[u64],
        actor: &str,
    ) -> Result<Vec<PullBulkResult>> {
        let mut results = Vec::with_capacity(numbers.len());
        for number in numbers {
            let outcome = self.pull_action(project_id, *number, "close", actor).await;
            results.push(PullBulkResult {
                number: *number,
                ok: outcome.is_ok(),
                message: outcome.err().map(|error| error.public_message()),
            });
        }
        Ok(results)
    }

    pub fn set_files_viewed(
        &self,
        project_id: &str,
        number: u64,
        paths: &[String],
        viewed: bool,
    ) -> Result<()> {
        self.store.project(project_id)?;
        self.store
            .set_files_viewed(project_id, number, paths, viewed)
    }

    /// The chain of open pull requests through `number`: each layer's base is the
    /// head of the one below it.
    pub async fn pull_stack(&self, project_id: &str, number: u64) -> Result<PullStack> {
        let filter = PullFilter {
            state: "open".into(),
            ..PullFilter::default()
        };
        let pulls = self.project_pulls(project_id, &filter).await?;
        stack_of(&pulls, number).ok_or_else(|| CoreError::NotFound("pull request".into()))
    }

    /// Merges from the bottom, or rebases each layer on the one below, stopping at
    /// the first failure. Earlier layers stand.
    pub async fn stack_action(
        &self,
        project_id: &str,
        number: u64,
        action: &StackAction,
        actor: &str,
    ) -> Result<Vec<PullBulkResult>> {
        if !matches!(action.action.as_str(), "merge" | "rebase") {
            return Err(CoreError::Invalid("Choose merge or rebase.".into()));
        }
        let stack = self.pull_stack(project_id, number).await?;
        let mut results = Vec::new();
        for layer in &stack.layers {
            let outcome = if action.action == "merge" {
                let options = MergePull {
                    method: action.method.clone().unwrap_or_else(|| "merge".to_owned()),
                    auto: false,
                    delete_branch: false,
                    subject: None,
                    body: None,
                    strip_credits: false,
                };
                self.merge_project_pull(project_id, layer.number, &options, actor)
                    .await
            } else {
                self.pull_action(project_id, layer.number, "rebase", actor)
                    .await
            };
            let failed = outcome.is_err();
            results.push(PullBulkResult {
                number: layer.number,
                ok: !failed,
                message: outcome.err().map(|error| error.public_message()),
            });
            if failed {
                break;
            }
        }
        Ok(results)
    }

    /// Checks a pull request out, in place or in a worktree of its own, and warns
    /// when the local head is not the forge's latest.
    pub async fn checkout_pull(
        &self,
        project_id: &str,
        number: u64,
        request: &CheckoutPull,
        actor: &str,
    ) -> Result<PullCheckout> {
        let (project, forge) = self.pull_site(project_id).await?;
        let cwd = PathBuf::from(&project.path);
        let detail = forge::pull_detail(forge, &cwd, number).await?;
        let head = detail.pull.head.clone();
        git(&cwd, &["check-ref-format", "--branch", &head])
            .await
            .map_err(|_| CoreError::Git("The pull request's branch name is not valid.".into()))?;
        self.scm_audit(actor, "git.pull_checkout", &number.to_string(), None)?;
        // Git won't move a branch a checkout is on; the warning below says if it's behind.
        let worktrees = git(&cwd, &["worktree", "list", "--porcelain"]).await?;
        let held = format!("branch refs/heads/{head}");
        if !String::from_utf8_lossy(&worktrees)
            .lines()
            .any(|line| line == held)
        {
            let spec = format!("+refs/{}/{number}/head:refs/heads/{head}", pull_ref(forge));
            let fetched = git_user(&cwd, &["fetch", "origin", &spec], PUSH_TIMEOUT).await;
            if fetched.is_err() {
                let spec = format!("+refs/heads/{head}:refs/heads/{head}");
                git_user(&cwd, &["fetch", "origin", &spec], PUSH_TIMEOUT).await?;
            }
        }
        let path = if request.worktree {
            let purpose = format!("pr-{number}");
            let path =
                crate::git::worktree_path(&crate::git::primary_checkout(&cwd).await?, &purpose)?;
            if !path.exists() {
                let target = path.to_string_lossy().into_owned();
                git_user(
                    &cwd,
                    &["worktree", "add", "-q", &target, &head],
                    PUSH_TIMEOUT,
                )
                .await?;
            }
            path
        } else {
            git_user(&cwd, &["switch", "-q", &head], FORGE_TIMEOUT).await?;
            cwd
        };
        let local = text(&git(&path, &["rev-parse", "HEAD"]).await?);
        let warning = detail
            .head_sha
            .filter(|sha| *sha != local)
            .map(|_| "This checkout is not on the pull request's latest commit.".to_owned());
        Ok(PullCheckout {
            path: path.to_string_lossy().into_owned(),
            branch: head,
            warning,
        })
    }

    /// A new thread on the pull request's own worktree, linked to it.
    pub async fn work_on_pull(
        &self,
        project_id: &str,
        number: u64,
        request: &WorkOnPull,
        actor: &str,
    ) -> Result<Thread> {
        let checkout = self
            .checkout_pull(project_id, number, &CheckoutPull { worktree: true }, actor)
            .await?;
        let (project, forge) = self.pull_site(project_id).await?;
        let pull = fetch_pull(forge, Path::new(&project.path), number).await?;
        let thread = self.store.create_thread(crate::store::NewThread {
            project_id: project_id.to_owned(),
            title: pull.title.clone(),
            engine: request.engine.clone(),
            model: request.model.clone(),
            cwd: checkout.path.clone(),
            worktree: Some(orbyn_contracts::Worktree {
                path: checkout.path,
                branch: checkout.branch,
                base: pull.base.clone(),
            }),
            skill_profile: None,
            parent_thread_id: None,
            relation: None,
            scratch: false,
        })?;
        self.store.link_pull(&thread.id, &pull)?;
        Ok(thread)
    }

    /// Creates the remote and pushes, through the origin-less project's chosen forge.
    pub async fn publish_project(
        &self,
        project_id: &str,
        request: &PublishProject,
        actor: &str,
    ) -> Result<()> {
        let project = self.store.project(project_id)?;
        if !project.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        let cwd = Path::new(&project.path);
        if git(cwd, &["remote", "get-url", "origin"]).await.is_ok() {
            return Err(CoreError::Invalid(
                "This project already has a remote.".into(),
            ));
        }
        let name = request.name.as_deref().unwrap_or(&project.name);
        if name.starts_with('-') {
            return Err(CoreError::Invalid(
                "That is not a valid repository name.".into(),
            ));
        }
        let forge = match request.forge.as_deref() {
            None | Some("github") => Forge::GitHub,
            Some("gitlab") => Forge::GitLab,
            Some(_) => {
                return Err(CoreError::Unsupported(
                    "Only GitHub and GitLab can publish from Orbyn.".into(),
                ));
            }
        };
        self.scm_audit(actor, "git.publish", name, None)?;
        forge::publish(forge, cwd, name, request.private).await
    }

    /// Every forge and what its CLI says about itself. This is also the rescan:
    /// nothing is cached, so asking again finds a CLI installed a moment ago.
    pub async fn forges(&self) -> Vec<ForgeStatus> {
        let mut statuses = Vec::with_capacity(ALL_FORGES.len());
        for forge in ALL_FORGES {
            statuses.push(forge::forge_status(forge).await);
        }
        statuses
    }
}

fn pull_ref(forge: Forge) -> &'static str {
    match forge {
        Forge::GitLab => "merge-requests",
        _ => "pull",
    }
}

fn check_state(state: &str) -> Result<()> {
    if matches!(state, "open" | "closed" | "merged" | "all") {
        Ok(())
    } else {
        Err(CoreError::Invalid("Unknown pull request state.".into()))
    }
}

/// Comment and thread ids go into API paths, so only plain characters pass.
fn check_opaque(id: &str) -> Result<()> {
    let plain = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '='));
    if plain {
        Ok(())
    } else {
        Err(CoreError::Invalid("That id is not valid.".into()))
    }
}

fn stack_of(pulls: &[PullRequest], number: u64) -> Option<PullStack> {
    let start = pulls.iter().find(|pull| pull.number == number)?;
    let by_head: HashMap<&str, &PullRequest> = pulls
        .iter()
        .map(|pull| (pull.head.as_str(), pull))
        .collect();
    let mut layers = vec![start.clone()];
    let mut below = by_head.get(start.base.as_str());
    while let Some(pull) = below {
        if layers.iter().any(|layer| layer.number == pull.number) {
            break;
        }
        layers.insert(0, (*pull).clone());
        below = by_head.get(pull.base.as_str());
    }
    let mut top = start.clone();
    while let Some(next) = pulls.iter().find(|pull| {
        pull.base == top.head && !layers.iter().any(|layer| layer.number == pull.number)
    }) {
        layers.push(next.clone());
        top = next.clone();
    }
    let position = layers.iter().position(|pull| pull.number == number)?;
    Some(PullStack { layers, position })
}

/// What a watch compares between passes.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct WatchState {
    checks: String,
    conflicting: bool,
    /// Comment and review ids, oldest first, with their authors.
    comments: Vec<(String, Option<String>)>,
    #[serde(skip)]
    finished: bool,
}

async fn read_watch(forge: Forge, cwd: &Path, number: u64) -> Result<(WatchState, Option<String>)> {
    let detail = forge::pull_detail(forge, cwd, number).await?;
    let finished = detail.pull.state != "open";
    let checks = forge::pull_checks(forge, cwd, number)
        .await
        .unwrap_or_default();
    let conversation = forge::conversation(forge, cwd, number).await?;
    let mut comments: Vec<(String, Option<String>)> = conversation
        .comments
        .iter()
        .chain(
            conversation
                .threads
                .iter()
                .flat_map(|thread| &thread.comments),
        )
        .map(|comment| (comment.id.clone(), comment.author.clone()))
        .collect();
    comments.sort();
    Ok((
        WatchState {
            checks: checks_word(&checks),
            conflicting: detail.mergeable.as_deref() == Some("conflicting"),
            comments,
            finished,
        },
        forge::viewer(forge, cwd).await,
    ))
}

fn checks_word(checks: &[PullCheck]) -> String {
    if checks.iter().any(|check| check.state == "fail") {
        "fail"
    } else if checks.iter().any(|check| check.state == "pending") {
        "pending"
    } else if checks.is_empty() {
        "none"
    } else {
        "pass"
    }
    .to_owned()
}

/// What changed since the last pass, and whether comments are all of it. Your own
/// comments are not news.
fn watch_news(last: &WatchState, now: &WatchState, viewer: Option<&str>) -> (Vec<String>, bool) {
    let mut news = Vec::new();
    if now.checks != last.checks {
        match now.checks.as_str() {
            "fail" => news.push("- A check failed.".to_owned()),
            "pass" => news.push("- All checks passed.".to_owned()),
            _ => {}
        }
    }
    if now.conflicting && !last.conflicting {
        news.push("- The branch now conflicts with its base.".to_owned());
    }
    let structural = !news.is_empty();
    let fresh = now
        .comments
        .iter()
        .filter(|comment| !last.comments.contains(comment))
        .filter(|(_, author)| author.as_deref() != viewer || viewer.is_none())
        .count();
    if fresh > 0 {
        news.push(format!("- {fresh} new comment(s) or review(s)."));
    }
    (news, !structural)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pull(number: u64, head: &str, base: &str) -> PullRequest {
        PullRequest {
            number,
            title: String::new(),
            url: String::new(),
            state: "open".into(),
            head: head.into(),
            base: base.into(),
            author: None,
            draft: false,
            updated_at: None,
            labels: Vec::new(),
            review_state: None,
            checks_state: None,
        }
    }

    #[test]
    fn a_stack_follows_bases_both_ways() {
        let pulls = [
            pull(1, "a", "main"),
            pull(2, "b", "a"),
            pull(3, "c", "b"),
            pull(9, "other", "main"),
        ];
        let stack = stack_of(&pulls, 2).unwrap();
        let numbers: Vec<u64> = stack.layers.iter().map(|layer| layer.number).collect();
        assert_eq!(numbers, [1, 2, 3]);
        assert_eq!(stack.position, 1);
        assert_eq!(stack_of(&pulls, 9).unwrap().layers.len(), 1);
        assert!(stack_of(&pulls, 42).is_none());
    }

    #[test]
    fn a_stack_with_a_cycle_still_ends() {
        let pulls = [pull(1, "a", "b"), pull(2, "b", "a")];
        assert_eq!(stack_of(&pulls, 1).unwrap().layers.len(), 2);
    }

    #[test]
    fn watch_news_skips_your_own_comments() {
        let last = WatchState {
            checks: "pending".into(),
            ..WatchState::default()
        };
        let mut now = last.clone();
        now.comments = vec![("1".into(), Some("me".into()))];
        assert!(watch_news(&last, &now, Some("me")).0.is_empty());
        now.comments.push(("2".into(), Some("them".into())));
        let (news, comments_only) = watch_news(&last, &now, Some("me"));
        assert_eq!(news, ["- 1 new comment(s) or review(s)."]);
        assert!(comments_only);
        now.checks = "fail".into();
        let (news, comments_only) = watch_news(&last, &now, Some("me"));
        assert_eq!(news.len(), 2);
        assert!(!comments_only);
    }

    #[test]
    fn ids_for_api_paths_stay_plain() {
        assert!(check_opaque("PRRT_kw-1=").is_ok());
        assert!(check_opaque("1/../2").is_err());
        assert!(check_opaque("").is_err());
    }
}
