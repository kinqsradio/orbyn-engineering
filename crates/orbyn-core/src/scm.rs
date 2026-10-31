//! Source control on a thread's checkout. Forge work goes through the user's own
//! `gh` or `glab`, so their login stays theirs and Orbyn holds no credential. All
//! of it needs a trusted folder, and commit hooks do run here, as they would for
//! the user. Writes wait for the thread's run to finish.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use orbyn_contracts::{
    BranchInfo, CreateBranch, GitAction, GitActionResult, GitPhase, PublishProject, PullRequest,
    PullRequestDetail, PullRequestDraft, SubmitReview, Thread,
};
use serde_json::{Value, json};
use tokio::process::Command;

use crate::app::Core;
use crate::error::{CoreError, Result};
use crate::git::{git, text};
use crate::process::resolve;
use crate::store::AuditRecord;
use crate::util::tail;

const FORGE_TIMEOUT: Duration = Duration::from_secs(120);
const PUSH_TIMEOUT: Duration = Duration::from_secs(300);
const PULL_FIELDS: &str = "number,title,url,state,headRefName,baseRefName,author";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Forge {
    GitHub,
    GitLab,
}

impl Forge {
    /// Reads the host from a remote URL. A host merely containing the word in
    /// its path does not count.
    pub fn of_remote(url: &str) -> Self {
        let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
        let rest = rest.rsplit_once('@').map_or(rest, |(_, rest)| rest);
        let host = rest.split(['/', ':']).next().unwrap_or("");
        if host.to_lowercase().contains("gitlab") {
            Self::GitLab
        } else {
            Self::GitHub
        }
    }

    fn program(self) -> &'static str {
        match self {
            Self::GitHub => "gh",
            Self::GitLab => "glab",
        }
    }
}

/// Runs git for a real user action: hooks stay on, and nothing may prompt.
async fn git_user(cwd: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
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

async fn forge_call(forge: Forge, cwd: &Path, args: &[&str]) -> Result<String> {
    let program = forge.program();
    let command = resolve(program).ok_or_else(|| {
        CoreError::Unsupported(format!("Install {program} and sign in to it to use this."))
    })?;
    let mut builder = Command::new(&command.program);
    builder
        .args(&command.prefix)
        .args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GLAB_NO_PROMPT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(FORGE_TIMEOUT, builder.output())
        .await
        .map_err(|_| CoreError::Git(format!("{program} did not finish in time.")))?
        .map_err(|error| CoreError::Git(format!("Could not run {program}: {error}")))?;
    if !output.status.success() {
        return Err(CoreError::Git(tail(
            &String::from_utf8_lossy(&output.stderr),
            1024,
        )));
    }
    Ok(text(&output.stdout))
}

async fn forge_of(cwd: &Path) -> Result<Forge> {
    let url = git(cwd, &["remote", "get-url", "origin"])
        .await
        .map_err(|_| CoreError::Invalid("This project has no origin remote.".into()))?;
    Ok(Forge::of_remote(&text(&url)))
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Reads either forge's JSON into one shape. States are lowercase and `opened`
/// is GitLab's word for open.
pub fn parse_pull(value: &Value) -> Option<PullRequest> {
    let number = value.get("number").or_else(|| value.get("iid"))?.as_u64()?;
    let state = field(value, "state").to_lowercase();
    let head = [field(value, "headRefName"), field(value, "source_branch")].concat();
    let base = [field(value, "baseRefName"), field(value, "target_branch")].concat();
    let url = [field(value, "url"), field(value, "web_url")].concat();
    let author = value
        .pointer("/author/login")
        .or_else(|| value.pointer("/author/username"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(PullRequest {
        number,
        title: field(value, "title").to_owned(),
        url,
        state: if state == "opened" {
            "open".to_owned()
        } else {
            state
        },
        head,
        base,
        author,
    })
}

async fn fetch_pull(forge: Forge, cwd: &Path, number: u64) -> Result<PullRequest> {
    let number = number.to_string();
    let output = match forge {
        Forge::GitHub => {
            forge_call(forge, cwd, &["pr", "view", &number, "--json", PULL_FIELDS]).await?
        }
        Forge::GitLab => {
            forge_call(forge, cwd, &["mr", "view", &number, "--output", "json"]).await?
        }
    };
    let value: Value = serde_json::from_str(&output)?;
    parse_pull(&value).ok_or_else(|| CoreError::Git("The forge returned no pull request.".into()))
}

async fn create_pull(
    forge: Forge,
    cwd: &Path,
    branch: &str,
    draft: &PullRequestDraft,
) -> Result<String> {
    let mut args: Vec<&str> = match forge {
        Forge::GitHub => vec![
            "pr",
            "create",
            "--title",
            &draft.title,
            "--body",
            &draft.body,
            "--head",
            branch,
        ],
        Forge::GitLab => vec![
            "mr",
            "create",
            "--title",
            &draft.title,
            "--description",
            &draft.body,
            "--source-branch",
            branch,
            "--yes",
        ],
    };
    if let Some(base) = &draft.base {
        args.push(match forge {
            Forge::GitHub => "--base",
            Forge::GitLab => "--target-branch",
        });
        args.push(base);
    }
    let output = forge_call(forge, cwd, &args).await?;
    Ok(output
        .lines()
        .rfind(|line| line.starts_with("http"))
        .unwrap_or(&output)
        .trim()
        .to_owned())
}

fn number_from_url(url: &str) -> Option<u64> {
    url.trim_end_matches('/').rsplit('/').next()?.parse().ok()
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
        let url = create_pull(forge, cwd, branch, draft).await?;
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
        let mut merged = false;
        for pull in self.store.linked_pulls(id)? {
            if pull.state != "open" {
                continue;
            }
            let fresh = fetch_pull(forge, cwd, pull.number).await?;
            merged |= fresh.state == "merged";
            self.store.link_pull(id, &fresh)?;
        }
        let on_merge = self.store.settings()?.auto_settle.on_merge;
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

    /// One pass of the pull request watch. A failure waits for the next pass.
    pub async fn watch_pulls(&self) {
        let threads = self.store.threads_with_open_pulls().unwrap_or_default();
        for id in threads {
            if let Err(error) = self.refresh_pulls(&id).await {
                tracing::debug!(%error, "could not refresh a pull request");
            }
        }
    }

    pub async fn pull_detail(&self, id: &str, number: u64) -> Result<PullRequestDetail> {
        let thread = self.scm_thread(id)?;
        let cwd = Path::new(&thread.cwd);
        let forge = forge_of(cwd).await?;
        let pull = fetch_pull(forge, cwd, number).await?;
        let number = number.to_string();
        let (body, comments, checks) = match forge {
            Forge::GitHub => {
                let view = forge_call(
                    forge,
                    cwd,
                    &["pr", "view", &number, "--json", "body,comments,reviews"],
                )
                .await?;
                let view: Value = serde_json::from_str(&view)?;
                // `gh pr checks` exits non-zero while checks fail or wait.
                let checks = forge_call(
                    forge,
                    cwd,
                    &["pr", "checks", &number, "--json", "name,state,link"],
                )
                .await
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or(json!([]));
                (
                    field(&view, "body").to_owned(),
                    json!({ "comments": view.get("comments"), "reviews": view.get("reviews") }),
                    checks,
                )
            }
            Forge::GitLab => {
                let view =
                    forge_call(forge, cwd, &["mr", "view", &number, "--output", "json"]).await?;
                let view: Value = serde_json::from_str(&view)?;
                (
                    field(&view, "description").to_owned(),
                    view.get("notes").cloned().unwrap_or(json!([])),
                    view.get("head_pipeline").cloned().unwrap_or(json!(null)),
                )
            }
        };
        Ok(PullRequestDetail {
            pull,
            body,
            checks,
            comments,
        })
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
        let number = number.to_string();
        let forge = forge_of(cwd).await?;
        self.scm_audit(actor, "git.review", &number, Some(id))?;
        match (forge, review.event.as_str()) {
            (Forge::GitHub, "approve" | "request_changes" | "comment") => {
                let flag = format!("--{}", review.event.replace('_', "-"));
                forge_call(
                    forge,
                    cwd,
                    &["pr", "review", &number, &flag, "--body", &review.body],
                )
                .await?;
            }
            (Forge::GitLab, "approve") => {
                forge_call(forge, cwd, &["mr", "approve", &number]).await?;
            }
            (Forge::GitLab, "comment") => {
                forge_call(
                    forge,
                    cwd,
                    &["mr", "note", &number, "--message", &review.body],
                )
                .await?;
            }
            _ => {
                return Err(CoreError::Invalid(
                    "That review action is not available.".into(),
                ));
            }
        }
        Ok(())
    }

    pub async fn merge_pull(&self, id: &str, number: u64, method: &str, actor: &str) -> Result<()> {
        let thread = self.scm_thread(id)?;
        let cwd = Path::new(&thread.cwd);
        if !matches!(method, "merge" | "squash" | "rebase") {
            return Err(CoreError::Invalid("Choose merge, squash or rebase.".into()));
        }
        let forge = forge_of(cwd).await?;
        let number = number.to_string();
        self.scm_audit(actor, "git.merge", &number, Some(id))?;
        match forge {
            Forge::GitHub => {
                let flag = format!("--{method}");
                forge_call(forge, cwd, &["pr", "merge", &number, &flag]).await?;
            }
            Forge::GitLab => {
                let mut args = vec!["mr", "merge", number.as_str(), "--yes"];
                match method {
                    "squash" => args.push("--squash"),
                    "rebase" => args.push("--rebase"),
                    _ => {}
                }
                forge_call(forge, cwd, &args).await?;
            }
        }
        self.refresh_pulls(id).await.map(|_| ())
    }

    pub async fn project_pulls(&self, project_id: &str, state: &str) -> Result<Vec<PullRequest>> {
        let project = self.store.project(project_id)?;
        if !project.trusted {
            return Err(CoreError::FolderUntrusted);
        }
        if !matches!(state, "open" | "closed" | "merged" | "all") {
            return Err(CoreError::Invalid("Unknown pull request state.".into()));
        }
        let cwd = Path::new(&project.path);
        let forge = forge_of(cwd).await?;
        let output = match forge {
            Forge::GitHub => {
                forge_call(
                    forge,
                    cwd,
                    &["pr", "list", "--state", state, "--json", PULL_FIELDS],
                )
                .await?
            }
            Forge::GitLab => {
                let mut args = vec!["mr", "list", "--output", "json"];
                match state {
                    "closed" => args.push("--closed"),
                    "merged" => args.push("--merged"),
                    "all" => args.push("--all"),
                    _ => {}
                }
                forge_call(forge, cwd, &args).await?
            }
        };
        let values: Vec<Value> = serde_json::from_str(&output)?;
        Ok(values.iter().filter_map(parse_pull).collect())
    }

    /// Creates the remote and pushes. Only GitHub has a one-step route here.
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
        self.scm_audit(actor, "git.publish", name, None)?;
        let visibility = if request.private {
            "--private"
        } else {
            "--public"
        };
        forge_call(
            Forge::GitHub,
            cwd,
            &[
                "repo", "create", name, visibility, "--source", ".", "--push",
            ],
        )
        .await
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_comes_from_the_host_alone() {
        assert_eq!(Forge::of_remote("git@github.com:a/b.git"), Forge::GitHub);
        assert_eq!(Forge::of_remote("git@gitlab.com:a/b.git"), Forge::GitLab);
        assert_eq!(
            Forge::of_remote("https://gitlab.acme.dev/a/b"),
            Forge::GitLab
        );
        assert_eq!(
            Forge::of_remote("https://github.com/gitlab/b"),
            Forge::GitHub
        );
        assert_eq!(
            Forge::of_remote("ssh://git@gitlab.x.io:2222/a/b"),
            Forge::GitLab
        );
    }

    #[test]
    fn both_forges_read_into_one_shape() {
        let hub = json!({
            "number": 7, "title": "T", "url": "https://x/7", "state": "MERGED",
            "headRefName": "feat", "baseRefName": "main", "author": { "login": "a" },
        });
        let pull = parse_pull(&hub).unwrap();
        assert_eq!(pull.state, "merged");
        assert_eq!(pull.author.as_deref(), Some("a"));
        let lab = json!({
            "iid": 9, "title": "T", "web_url": "https://x/9", "state": "opened",
            "source_branch": "feat", "target_branch": "main", "author": { "username": "b" },
        });
        let pull = parse_pull(&lab).unwrap();
        assert_eq!((pull.number, pull.state.as_str()), (9, "open"));
        assert_eq!(pull.head, "feat");
        assert!(parse_pull(&json!({ "title": "no number" })).is_none());
    }

    #[test]
    fn pull_numbers_come_from_the_url() {
        assert_eq!(
            number_from_url("https://github.com/a/b/pull/12\n".trim()),
            Some(12)
        );
        assert_eq!(number_from_url("https://x/a/-/merge_requests/3/"), Some(3));
        assert_eq!(number_from_url("not a url"), None);
    }
}
