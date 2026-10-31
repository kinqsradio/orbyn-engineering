//! Forge reads and writes through each forge's own CLI, so a login stays the
//! user's and Orbyn holds no credential. No shell parses an argument. GitHub and
//! GitLab cover everything their APIs offer through `gh api` and `glab api`, Azure
//! DevOps and Forgejo cover the basics their CLIs have, and Bitbucket has no CLI to
//! go through, so it reports that instead of asking for a token.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use orbyn_contracts::{
    AddPullComment, MergePull, PullCandidate, PullCheck, PullComment, PullConversation, PullFile,
    PullRequest, PullRequestDetail, PullRevision, PullThread, PullTimelineEvent, ReviewLineComment,
    SetPullPeople, SubmitReview, UpdatePull,
};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::error::{CoreError, Result};
use crate::git::{git, text};
use crate::process::resolve;
use crate::util::tail;

const FORGE_TIMEOUT: Duration = Duration::from_secs(120);
const LIST_LIMIT: &str = "100";
const GH_LIST_FIELDS: &str = "number,title,url,state,headRefName,baseRefName,author,isDraft,\
updatedAt,labels,reviewDecision,statusCheckRollup";
const GH_VIEW_FIELDS: &str = "number,title,url,state,headRefName,baseRefName,author,isDraft,\
updatedAt,labels,reviewDecision,statusCheckRollup,body,comments,reviews,mergeable,reviewRequests,\
headRefOid,baseRefOid,additions,deletions,changedFiles,maintainerCanModify,autoMergeRequest";
const THREADS_QUERY: &str = "query($owner:String!,$repo:String!,$number:Int!){\
repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{\
id isResolved path line comments(first:100){nodes{databaseId body createdAt author{login}}}}}}}}";
const RESOLVE_MUTATION: &str =
    "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}";
const UNRESOLVE_MUTATION: &str =
    "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Forge {
    GitHub,
    GitLab,
    Azure,
    Forgejo,
    Bitbucket,
}

pub const ALL_FORGES: [Forge; 5] = [
    Forge::GitHub,
    Forge::GitLab,
    Forge::Azure,
    Forge::Forgejo,
    Forge::Bitbucket,
];

impl Forge {
    /// Reads the host from a remote URL. A word in the path does not count. An
    /// unknown host is GitHub, so GitHub Enterprise works through `gh`.
    pub fn of_remote(url: &str) -> Self {
        let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
        let rest = rest.rsplit_once('@').map_or(rest, |(_, rest)| rest);
        let host = rest.split(['/', ':']).next().unwrap_or("").to_lowercase();
        if host.contains("gitlab") {
            Self::GitLab
        } else if host == "dev.azure.com"
            || host.ends_with(".dev.azure.com")
            || host.ends_with(".visualstudio.com")
        {
            Self::Azure
        } else if host.contains("bitbucket") {
            Self::Bitbucket
        } else if host.contains("codeberg") || host.contains("forgejo") || host.contains("gitea") {
            Self::Forgejo
        } else {
            Self::GitHub
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
            Self::Azure => "azure",
            Self::Forgejo => "forgejo",
            Self::Bitbucket => "bitbucket",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::GitLab => "GitLab",
            Self::Azure => "Azure DevOps",
            Self::Forgejo => "Forgejo",
            Self::Bitbucket => "Bitbucket",
        }
    }

    pub fn program(self) -> Option<&'static str> {
        match self {
            Self::GitHub => Some("gh"),
            Self::GitLab => Some("glab"),
            Self::Azure => Some("az"),
            Self::Forgejo => Some("tea"),
            Self::Bitbucket => None,
        }
    }

    fn unsupported(self, what: &str) -> CoreError {
        CoreError::Unsupported(format!("{} cannot {what} from Orbyn.", self.name()))
    }
}

pub async fn forge_of(cwd: &Path) -> Result<Forge> {
    let url = git(cwd, &["remote", "get-url", "origin"])
        .await
        .map_err(|_| CoreError::Invalid("This project has no origin remote.".into()))?;
    Ok(Forge::of_remote(&text(&url)))
}

/// What one CLI call produced. Some commands report through their exit code.
struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

async fn spawn(forge: Forge, cwd: &Path, args: &[&str], input: Option<&str>) -> Result<Output> {
    let program = forge.program().ok_or_else(|| {
        CoreError::Unsupported(format!(
            "{} has no command line tool, and Orbyn does not hold forge tokens.",
            forge.name()
        ))
    })?;
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
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let run = async {
        crate::child_env::for_tool(builder.as_std_mut());
        let mut child = builder.spawn()?;
        if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
            stdin.write_all(input.as_bytes()).await?;
        }
        child.wait_with_output().await
    };
    let output = tokio::time::timeout(FORGE_TIMEOUT, run)
        .await
        .map_err(|_| CoreError::Git(format!("{program} did not finish in time.")))?
        .map_err(|error| CoreError::Git(format!("Could not run {program}: {error}")))?;
    Ok(Output {
        success: output.status.success(),
        stdout: text(&output.stdout),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

pub async fn call(forge: Forge, cwd: &Path, args: &[&str]) -> Result<String> {
    let output = spawn(forge, cwd, args, None).await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(CoreError::Git(tail(&output.stderr, 1024)))
    }
}

async fn call_input(forge: Forge, cwd: &Path, args: &[&str], input: &str) -> Result<String> {
    let output = spawn(forge, cwd, args, Some(input)).await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(CoreError::Git(tail(&output.stderr, 1024)))
    }
}

async fn call_json(forge: Forge, cwd: &Path, args: &[&str]) -> Result<Value> {
    Ok(serde_json::from_str(&call(forge, cwd, args).await?)?)
}

/// `--paginate` prints one array per page, so they are read one after another.
async fn call_pages(forge: Forge, cwd: &Path, args: &[&str]) -> Result<Vec<Value>> {
    let output = call(forge, cwd, args).await?;
    let mut items = Vec::new();
    for page in serde_json::Deserializer::from_str(&output).into_iter::<Value>() {
        match page? {
            Value::Array(list) => items.extend(list),
            other => items.push(other),
        }
    }
    Ok(items)
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn optional(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn id_of(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn person(value: &Value) -> Option<String> {
    value
        .get("login")
        .or_else(|| value.get("username"))
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn check_state(status: &str, conclusion: &str) -> &'static str {
    match (
        status.to_uppercase().as_str(),
        conclusion.to_uppercase().as_str(),
    ) {
        (_, "SUCCESS" | "PASS" | "PASSED") | ("SUCCESS" | "PASS" | "PASSED", _) => "pass",
        (_, "FAILURE" | "FAIL" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "CANCELED" | "ERROR")
        | ("FAILURE" | "FAIL" | "FAILED" | "ERROR", _) => "fail",
        (_, "SKIPPED" | "SKIPPING") | ("SKIPPED" | "SKIPPING", _) => "skipped",
        (_, "NEUTRAL") => "neutral",
        _ => "pending",
    }
}

/// One word for a whole check list: a failure wins, then anything unfinished.
fn rollup(states: impl Iterator<Item = String>) -> String {
    let states: Vec<String> = states.collect();
    if states.is_empty() {
        "none"
    } else if states.iter().any(|state| state == "fail") {
        "fail"
    } else if states.iter().any(|state| state == "pending") {
        "pending"
    } else {
        "pass"
    }
    .to_owned()
}

fn github_rollup(value: &Value) -> Option<String> {
    let checks = value.get("statusCheckRollup")?.as_array()?;
    Some(rollup(checks.iter().map(|check| {
        let status = [field(check, "status"), field(check, "state")].concat();
        check_state(&status, field(check, "conclusion")).to_owned()
    })))
}

fn review_word(decision: &str) -> String {
    match decision.to_uppercase().as_str() {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" => "changes_requested",
        "REVIEW_REQUIRED" => "review_required",
        _ => "none",
    }
    .to_owned()
}

/// Reads any forge's JSON into one shape. States are lowercase and `opened` is
/// GitLab's word for open.
pub fn parse_pull(value: &Value) -> Option<PullRequest> {
    let number = value
        .get("number")
        .or_else(|| value.get("iid"))
        .or_else(|| value.get("index"))
        .or_else(|| value.get("pullRequestId"))?
        .as_u64()?;
    let state = [field(value, "state"), field(value, "status")]
        .concat()
        .to_lowercase();
    let strip = |name: &str| name.trim_start_matches("refs/heads/").to_owned();
    let head = [
        field(value, "headRefName"),
        field(value, "source_branch"),
        field(value, "head"),
        field(value, "sourceRefName"),
    ]
    .concat();
    let base = [
        field(value, "baseRefName"),
        field(value, "target_branch"),
        field(value, "base"),
        field(value, "targetRefName"),
    ]
    .concat();
    let url = [field(value, "url"), field(value, "web_url")].concat();
    let author = value
        .get("author")
        .and_then(person)
        .or_else(|| {
            value
                .pointer("/createdBy/displayName")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| optional(value, "poster"));
    let labels = value
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|label| {
            label
                .as_str()
                .map(str::to_owned)
                .or_else(|| optional(label, "name"))
        })
        .collect();
    let draft = ["isDraft", "draft"]
        .iter()
        .any(|key| value.get(*key).and_then(Value::as_bool) == Some(true));
    Some(PullRequest {
        number,
        title: field(value, "title").to_owned(),
        url,
        state: match state.as_str() {
            "opened" | "active" => "open".to_owned(),
            "completed" => "merged".to_owned(),
            "abandoned" => "closed".to_owned(),
            _ => state,
        },
        head: strip(&head),
        base: strip(&base),
        author,
        draft,
        updated_at: optional(value, "updatedAt").or_else(|| optional(value, "updated_at")),
        labels,
        review_state: value
            .get("reviewDecision")
            .map(|decision| review_word(decision.as_str().unwrap_or_default())),
        checks_state: github_rollup(value),
    })
}

pub async fn fetch_pull(forge: Forge, cwd: &Path, number: u64) -> Result<PullRequest> {
    let id = number.to_string();
    let value = match forge {
        Forge::GitHub => {
            call_json(forge, cwd, &["pr", "view", &id, "--json", GH_LIST_FIELDS]).await?
        }
        Forge::GitLab => call_json(forge, cwd, &["mr", "view", &id, "--output", "json"]).await?,
        Forge::Azure => {
            call_json(
                forge,
                cwd,
                &[
                    "repos", "pr", "show", "--id", &id, "--detect", "true", "--output", "json",
                ],
            )
            .await?
        }
        Forge::Forgejo => forgejo_pull(cwd, number).await?,
        Forge::Bitbucket => return Err(forge.unsupported("read pull requests")),
    };
    parse_pull(&value).ok_or_else(|| CoreError::Git("The forge returned no pull request.".into()))
}

async fn forgejo_pull(cwd: &Path, number: u64) -> Result<Value> {
    let listed = call_json(
        Forge::Forgejo,
        cwd,
        &[
            "pulls",
            "list",
            "--state",
            "all",
            "--output",
            "json",
            "--fields",
            "index,title,state,author,url,head,base,labels,updated",
        ],
    )
    .await?;
    listed
        .as_array()
        .into_iter()
        .flatten()
        .find(|pull| id_of(pull, "index") == number.to_string())
        .cloned()
        .ok_or_else(|| CoreError::NotFound("pull request".into()))
}

/// Filters for a list. Empty fields do not narrow it.
#[derive(Clone, Debug, Default)]
pub struct PullFilter {
    pub state: String,
    pub search: Option<String>,
    pub author: Option<String>,
    pub label: Option<String>,
    pub head: Option<String>,
}

pub async fn list_pulls(forge: Forge, cwd: &Path, filter: &PullFilter) -> Result<Vec<PullRequest>> {
    let mut args: Vec<&str>;
    match forge {
        Forge::GitHub => {
            args = vec![
                "pr",
                "list",
                "--limit",
                LIST_LIMIT,
                "--state",
                &filter.state,
                "--json",
                GH_LIST_FIELDS,
            ];
            for (flag, value) in [
                ("--search", &filter.search),
                ("--author", &filter.author),
                ("--label", &filter.label),
                ("--head", &filter.head),
            ] {
                if let Some(value) = value {
                    args.extend([flag, value.as_str()]);
                }
            }
        }
        Forge::GitLab => {
            args = vec!["mr", "list", "--per-page", LIST_LIMIT, "--output", "json"];
            match filter.state.as_str() {
                "closed" => args.push("--closed"),
                "merged" => args.push("--merged"),
                "all" => args.push("--all"),
                _ => {}
            }
            for (flag, value) in [
                ("--search", &filter.search),
                ("--author", &filter.author),
                ("--label", &filter.label),
                ("--source-branch", &filter.head),
            ] {
                if let Some(value) = value {
                    args.extend([flag, value.as_str()]);
                }
            }
        }
        Forge::Azure => {
            let status = match filter.state.as_str() {
                "open" => "active",
                "merged" => "completed",
                "closed" => "abandoned",
                _ => "all",
            };
            args = vec![
                "repos", "pr", "list", "--detect", "true", "--status", status, "--top", LIST_LIMIT,
                "--output", "json",
            ];
        }
        Forge::Forgejo => {
            let state = if filter.state == "merged" {
                "closed"
            } else {
                filter.state.as_str()
            };
            args = vec![
                "pulls",
                "list",
                "--state",
                state,
                "--output",
                "json",
                "--limit",
                LIST_LIMIT,
                "--fields",
                "index,title,state,author,url,head,base,labels,updated",
            ];
        }
        Forge::Bitbucket => return Err(forge.unsupported("list pull requests")),
    }
    let values: Vec<Value> = serde_json::from_str(&call(forge, cwd, &args).await?)?;
    let mut pulls: Vec<PullRequest> = values.iter().filter_map(parse_pull).collect();
    // Azure and Forgejo have no such flags, so they are applied here.
    if matches!(forge, Forge::Azure | Forge::Forgejo) {
        if let Some(needle) = &filter.search {
            let needle = needle.to_lowercase();
            pulls.retain(|pull| pull.title.to_lowercase().contains(&needle));
        }
        if let Some(head) = &filter.head {
            pulls.retain(|pull| pull.head == *head);
        }
        if let Some(author) = &filter.author {
            pulls.retain(|pull| pull.author.as_deref() == Some(author));
        }
        if let Some(label) = &filter.label {
            pulls.retain(|pull| pull.labels.contains(label));
        }
    }
    Ok(pulls)
}

pub async fn pull_detail(forge: Forge, cwd: &Path, number: u64) -> Result<PullRequestDetail> {
    let id = number.to_string();
    match forge {
        Forge::GitHub => {
            let view =
                call_json(forge, cwd, &["pr", "view", &id, "--json", GH_VIEW_FIELDS]).await?;
            let pull = parse_pull(&view)
                .ok_or_else(|| CoreError::Git("The forge returned no pull request.".into()))?;
            let reviewers = view
                .get("reviewRequests")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(person)
                .collect();
            Ok(PullRequestDetail {
                pull,
                body: field(&view, "body").to_owned(),
                checks: raw_github_checks(cwd, &id).await,
                comments: json!({ "comments": view.get("comments"), "reviews": view.get("reviews") }),
                mergeable: optional(&view, "mergeable").map(|word| word.to_lowercase()),
                reviewers,
                head_sha: optional(&view, "headRefOid"),
                base_sha: optional(&view, "baseRefOid"),
                additions: view.get("additions").and_then(Value::as_u64),
                deletions: view.get("deletions").and_then(Value::as_u64),
                changed_files: view.get("changedFiles").and_then(Value::as_u64),
                maintainer_can_modify: view.get("maintainerCanModify").and_then(Value::as_bool),
                auto_merge: view
                    .get("autoMergeRequest")
                    .is_some_and(|auto| !auto.is_null()),
            })
        }
        Forge::GitLab => {
            let view = call_json(forge, cwd, &["mr", "view", &id, "--output", "json"]).await?;
            let pull = parse_pull(&view)
                .ok_or_else(|| CoreError::Git("The forge returned no pull request.".into()))?;
            Ok(PullRequestDetail {
                pull,
                body: field(&view, "description").to_owned(),
                checks: view.get("head_pipeline").cloned().unwrap_or(json!(null)),
                comments: view.get("notes").cloned().unwrap_or(json!([])),
                mergeable: optional(&view, "detailed_merge_status").map(|word| {
                    if word == "conflict" {
                        "conflicting".to_owned()
                    } else if word == "mergeable" {
                        word
                    } else {
                        "unknown".to_owned()
                    }
                }),
                reviewers: view
                    .get("reviewers")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(person)
                    .collect(),
                head_sha: optional(&view, "sha"),
                base_sha: view
                    .pointer("/diff_refs/base_sha")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                additions: None,
                deletions: None,
                changed_files: view
                    .get("changes_count")
                    .and_then(Value::as_str)
                    .and_then(|n| n.parse().ok()),
                maintainer_can_modify: view.get("allow_collaboration").and_then(Value::as_bool),
                auto_merge: view
                    .get("merge_when_pipeline_succeeds")
                    .and_then(Value::as_bool)
                    == Some(true),
            })
        }
        Forge::Azure | Forge::Forgejo => Ok(PullRequestDetail {
            pull: fetch_pull(forge, cwd, number).await?,
            body: String::new(),
            checks: json!([]),
            comments: json!([]),
            mergeable: None,
            reviewers: Vec::new(),
            head_sha: None,
            base_sha: None,
            additions: None,
            deletions: None,
            changed_files: None,
            maintainer_can_modify: None,
            auto_merge: false,
        }),
        Forge::Bitbucket => Err(forge.unsupported("read pull requests")),
    }
}

/// `gh pr checks` exits non-zero while checks fail or wait, and still prints them.
async fn raw_github_checks(cwd: &Path, id: &str) -> Value {
    let args = [
        "pr",
        "checks",
        id,
        "--json",
        "name,state,link,workflow,description,bucket",
    ];
    match spawn(Forge::GitHub, cwd, &args, None).await {
        Ok(output) => serde_json::from_str(&output.stdout).unwrap_or(json!([])),
        Err(_) => json!([]),
    }
}

pub async fn pull_checks(forge: Forge, cwd: &Path, number: u64) -> Result<Vec<PullCheck>> {
    let id = number.to_string();
    match forge {
        Forge::GitHub => Ok(raw_github_checks(cwd, &id)
            .await
            .as_array()
            .into_iter()
            .flatten()
            .map(|check| PullCheck {
                name: field(check, "name").to_owned(),
                state: check_state(field(check, "state"), field(check, "bucket")).to_owned(),
                url: optional(check, "link"),
                workflow: optional(check, "workflow"),
                description: optional(check, "description"),
            })
            .collect()),
        Forge::GitLab => {
            let path = format!("projects/:id/merge_requests/{id}/pipelines");
            let pipelines = call_pages(forge, cwd, &["api", &path]).await?;
            Ok(pipelines
                .iter()
                .take(1)
                .map(|pipeline| PullCheck {
                    name: format!("Pipeline {}", id_of(pipeline, "id")),
                    state: check_state(field(pipeline, "status"), "").to_owned(),
                    url: optional(pipeline, "web_url"),
                    workflow: None,
                    description: None,
                })
                .collect())
        }
        _ => Ok(Vec::new()),
    }
}

/// Lets a fork's waiting workflow run.
pub async fn approve_workflow(forge: Forge, cwd: &Path, run_id: u64) -> Result<()> {
    if forge != Forge::GitHub {
        return Err(forge.unsupported("approve a workflow"));
    }
    let path = format!("repos/{{owner}}/{{repo}}/actions/runs/{run_id}/approve");
    call(forge, cwd, &["api", "-X", "POST", &path])
        .await
        .map(|_| ())
}

fn github_comment(value: &Value, kind: &str) -> PullComment {
    PullComment {
        id: id_of(value, "id"),
        kind: kind.to_owned(),
        author: value
            .get("user")
            .or_else(|| value.get("author"))
            .and_then(person),
        body: field(value, "body").to_owned(),
        created_at: optional(value, "created_at").or_else(|| optional(value, "createdAt")),
        path: optional(value, "path"),
        line: value.get("line").and_then(Value::as_u64),
    }
}

fn gitlab_comment(note: &Value) -> PullComment {
    PullComment {
        id: id_of(note, "id"),
        kind: "note".to_owned(),
        author: note.get("author").and_then(person),
        body: field(note, "body").to_owned(),
        created_at: optional(note, "created_at"),
        path: note
            .pointer("/position/new_path")
            .and_then(Value::as_str)
            .map(str::to_owned),
        line: note.pointer("/position/new_line").and_then(Value::as_u64),
    }
}

/// Splits a GraphQL `reviewThreads` reply into threads.
fn github_threads(reply: &Value) -> Vec<PullThread> {
    let nodes = reply.pointer("/data/repository/pullRequest/reviewThreads/nodes");
    nodes
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|thread| PullThread {
            id: field(thread, "id").to_owned(),
            resolved: thread.get("isResolved").and_then(Value::as_bool) == Some(true),
            path: optional(thread, "path"),
            line: thread.get("line").and_then(Value::as_u64),
            comments: thread
                .pointer("/comments/nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|comment| PullComment {
                    id: id_of(comment, "databaseId"),
                    kind: "review".to_owned(),
                    author: comment.get("author").and_then(person),
                    body: field(comment, "body").to_owned(),
                    created_at: optional(comment, "createdAt"),
                    path: optional(thread, "path"),
                    line: thread.get("line").and_then(Value::as_u64),
                })
                .collect(),
        })
        .collect()
}

/// A discussion with one system note is activity, not a conversation.
fn gitlab_conversation(discussions: &[Value]) -> PullConversation {
    let mut conversation = PullConversation {
        comments: Vec::new(),
        threads: Vec::new(),
    };
    for discussion in discussions {
        let notes: Vec<&Value> = discussion
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|note| note.get("system").and_then(Value::as_bool) != Some(true))
            .collect();
        let Some(first) = notes.first() else { continue };
        if first.get("resolvable").and_then(Value::as_bool) == Some(true) {
            conversation.threads.push(PullThread {
                id: field(discussion, "id").to_owned(),
                resolved: first.get("resolved").and_then(Value::as_bool) == Some(true),
                path: first
                    .pointer("/position/new_path")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                line: first.pointer("/position/new_line").and_then(Value::as_u64),
                comments: notes.iter().map(|note| gitlab_comment(note)).collect(),
            });
        } else {
            conversation
                .comments
                .extend(notes.iter().map(|note| gitlab_comment(note)));
        }
    }
    conversation
}

pub async fn conversation(forge: Forge, cwd: &Path, number: u64) -> Result<PullConversation> {
    let id = number.to_string();
    match forge {
        Forge::GitHub => {
            let path = format!("repos/{{owner}}/{{repo}}/issues/{id}/comments");
            let comments = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            let number_field = format!("number={id}");
            let query = format!("query={THREADS_QUERY}");
            let threads = call_json(
                forge,
                cwd,
                &[
                    "api",
                    "graphql",
                    "-F",
                    "owner={owner}",
                    "-F",
                    "repo={repo}",
                    "-F",
                    &number_field,
                    "-f",
                    &query,
                ],
            )
            .await?;
            Ok(PullConversation {
                comments: comments
                    .iter()
                    .map(|value| github_comment(value, "issue"))
                    .collect(),
                threads: github_threads(&threads),
            })
        }
        Forge::GitLab => {
            let path = format!("projects/:id/merge_requests/{id}/discussions?per_page=100");
            let discussions = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            Ok(gitlab_conversation(&discussions))
        }
        Forge::Azure | Forge::Forgejo => Ok(PullConversation {
            comments: Vec::new(),
            threads: Vec::new(),
        }),
        Forge::Bitbucket => Err(forge.unsupported("read comments")),
    }
}

pub async fn timeline(forge: Forge, cwd: &Path, number: u64) -> Result<Vec<PullTimelineEvent>> {
    let id = number.to_string();
    match forge {
        Forge::GitHub => {
            let path = format!("repos/{{owner}}/{{repo}}/issues/{id}/timeline");
            let events = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            Ok(events
                .iter()
                .map(|event| PullTimelineEvent {
                    id: id_of(event, "id"),
                    kind: field(event, "event").to_owned(),
                    actor: event
                        .get("actor")
                        .or_else(|| event.get("user"))
                        .and_then(person),
                    created_at: optional(event, "created_at")
                        .or_else(|| optional(event, "submitted_at")),
                    text: optional(event, "body").or_else(|| optional(event, "state")),
                })
                .collect())
        }
        Forge::GitLab => {
            let path = format!("projects/:id/merge_requests/{id}/notes?per_page=100&sort=asc");
            let notes = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            Ok(notes
                .iter()
                .map(|note| PullTimelineEvent {
                    id: id_of(note, "id"),
                    kind: if note.get("system").and_then(Value::as_bool) == Some(true) {
                        "system".to_owned()
                    } else {
                        "commented".to_owned()
                    },
                    actor: note.get("author").and_then(person),
                    created_at: optional(note, "created_at"),
                    text: optional(note, "body"),
                })
                .collect())
        }
        Forge::Azure | Forge::Forgejo => Ok(Vec::new()),
        Forge::Bitbucket => Err(forge.unsupported("read activity")),
    }
}

fn parse_github_file(file: &Value) -> PullFile {
    let status = field(file, "status");
    PullFile {
        path: field(file, "filename").to_owned(),
        previous_path: optional(file, "previous_filename"),
        status: match status {
            "removed" => "deleted",
            "changed" => "modified",
            other => other,
        }
        .to_owned(),
        additions: file.get("additions").and_then(Value::as_u64).unwrap_or(0),
        deletions: file.get("deletions").and_then(Value::as_u64).unwrap_or(0),
        patch: optional(file, "patch"),
        viewed: false,
    }
}

fn parse_gitlab_file(file: &Value) -> PullFile {
    let flag = |key: &str| file.get(key).and_then(Value::as_bool) == Some(true);
    let (mut additions, mut deletions) = (0, 0);
    let patch = optional(file, "diff");
    for line in patch.as_deref().unwrap_or_default().lines() {
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    PullFile {
        path: field(file, "new_path").to_owned(),
        previous_path: Some(field(file, "old_path").to_owned())
            .filter(|old| *old != field(file, "new_path")),
        status: if flag("new_file") {
            "added"
        } else if flag("deleted_file") {
            "deleted"
        } else if flag("renamed_file") {
            "renamed"
        } else {
            "modified"
        }
        .to_owned(),
        additions,
        deletions,
        patch,
        viewed: false,
    }
}

pub async fn pull_files(forge: Forge, cwd: &Path, number: u64) -> Result<Vec<PullFile>> {
    match forge {
        Forge::GitHub => {
            let path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/files?per_page=100");
            let files = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            Ok(files.iter().map(parse_github_file).collect())
        }
        Forge::GitLab => {
            let path = format!("projects/:id/merge_requests/{number}/diffs?per_page=100");
            let files = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            Ok(files.iter().map(parse_gitlab_file).collect())
        }
        _ => Err(forge.unsupported("list changed files")),
    }
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().to_owned()
}

fn parse_github_revision(commit: &Value) -> PullRevision {
    let detail = commit.get("commit").unwrap_or(&Value::Null);
    PullRevision {
        sha: optional(commit, "sha").unwrap_or_default(),
        message: first_line(&optional(detail, "message").unwrap_or_default()),
        author: commit
            .get("author")
            .and_then(|author| optional(author, "login"))
            .or_else(|| {
                detail
                    .get("author")
                    .and_then(|author| optional(author, "name"))
            }),
        committed_at: detail
            .get("committer")
            .and_then(|committer| optional(committer, "date")),
    }
}

fn parse_gitlab_revision(commit: &Value) -> PullRevision {
    PullRevision {
        sha: optional(commit, "id").unwrap_or_default(),
        message: first_line(&optional(commit, "title").unwrap_or_default()),
        author: optional(commit, "author_name"),
        committed_at: optional(commit, "committed_date"),
    }
}

/// The commits of a pull request, oldest first.
pub async fn pull_revisions(forge: Forge, cwd: &Path, number: u64) -> Result<Vec<PullRevision>> {
    match forge {
        Forge::GitHub => {
            let path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/commits?per_page=100");
            let commits = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            Ok(commits.iter().map(parse_github_revision).collect())
        }
        Forge::GitLab => {
            let path = format!("projects/:id/merge_requests/{number}/commits?per_page=100");
            let commits = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            // GitLab lists the newest first.
            Ok(commits.iter().rev().map(parse_gitlab_revision).collect())
        }
        _ => Err(forge.unsupported("list commits")),
    }
}

/// What one commit changed. The hash comes from the page, so it is checked here.
pub async fn revision_files(forge: Forge, cwd: &Path, sha: &str) -> Result<Vec<PullFile>> {
    if sha.is_empty() || !sha.chars().all(|letter| letter.is_ascii_hexdigit()) {
        return Err(CoreError::Invalid("That is not a commit.".into()));
    }
    match forge {
        Forge::GitHub => {
            let path = format!("repos/{{owner}}/{{repo}}/commits/{sha}");
            let commit: Value = serde_json::from_str(&call(forge, cwd, &["api", &path]).await?)
                .map_err(|error| CoreError::Git(error.to_string()))?;
            let files = commit.get("files").and_then(Value::as_array);
            Ok(files.into_iter().flatten().map(parse_github_file).collect())
        }
        Forge::GitLab => {
            let path = format!("projects/:id/repository/commits/{sha}/diff?per_page=100");
            let files = call_pages(forge, cwd, &["api", "--paginate", &path]).await?;
            Ok(files.iter().map(parse_gitlab_file).collect())
        }
        _ => Err(forge.unsupported("list changed files")),
    }
}

#[cfg(test)]
mod revision_tests {
    use super::*;

    #[test]
    fn a_github_commit_reads_its_first_line_and_login() {
        let revision = parse_github_revision(&json!({
            "sha": "abc",
            "author": { "login": "ada" },
            "commit": { "message": "Rename it\n\nBecause.", "committer": { "date": "2026-10-01T00:00:00Z" } },
        }));
        assert_eq!(revision.message, "Rename it");
        assert_eq!(revision.author.as_deref(), Some("ada"));
        assert_eq!(
            revision.committed_at.as_deref(),
            Some("2026-10-01T00:00:00Z")
        );
    }

    #[tokio::test]
    async fn a_hash_with_anything_else_in_it_never_reaches_the_forge() {
        let refused = revision_files(Forge::GitHub, Path::new("."), "abc/../x").await;
        assert!(matches!(refused, Err(CoreError::Invalid(_))));
    }
}

fn is_github_review(kind: &str) -> bool {
    kind == "review"
}

async fn head_sha(forge: Forge, cwd: &Path, number: u64) -> Result<(String, Value)> {
    let detail = pull_detail(forge, cwd, number).await?;
    let sha = detail
        .head_sha
        .ok_or_else(|| CoreError::Git("The forge gave no head commit.".into()))?;
    Ok((sha, json!({ "base_sha": detail.base_sha })))
}

pub async fn add_comment(
    forge: Forge,
    cwd: &Path,
    number: u64,
    request: &AddPullComment,
) -> Result<()> {
    let id = number.to_string();
    let body_field = format!("body={}", request.body);
    match (forge, &request.reply_to, &request.path, request.line) {
        (Forge::GitHub, Some(reply), _, _) => {
            let path = format!("repos/{{owner}}/{{repo}}/pulls/{id}/comments/{reply}/replies");
            call(forge, cwd, &["api", "-X", "POST", &path, "-f", &body_field]).await?;
        }
        (Forge::GitHub, None, Some(file), Some(line)) => {
            let (sha, _) = head_sha(forge, cwd, number).await?;
            let path = format!("repos/{{owner}}/{{repo}}/pulls/{id}/comments");
            let commit = format!("commit_id={sha}");
            let file = format!("path={file}");
            let line = format!("line={line}");
            call(
                forge,
                cwd,
                &[
                    "api",
                    "-X",
                    "POST",
                    &path,
                    "-f",
                    &body_field,
                    "-f",
                    &commit,
                    "-f",
                    &file,
                    "-F",
                    &line,
                    "-f",
                    "side=RIGHT",
                ],
            )
            .await?;
        }
        (Forge::GitHub, None, _, _) => {
            call(forge, cwd, &["pr", "comment", &id, "--body", &request.body]).await?;
        }
        (Forge::GitLab, Some(reply), _, _) => {
            let path = format!("projects/:id/merge_requests/{id}/discussions/{reply}/notes");
            call(forge, cwd, &["api", "-X", "POST", &path, "-f", &body_field]).await?;
        }
        (Forge::GitLab, None, Some(file), Some(line)) => {
            let (sha, refs) = head_sha(forge, cwd, number).await?;
            let path = format!("projects/:id/merge_requests/{id}/discussions");
            let base = format!("position[base_sha]={}", field(&refs, "base_sha"));
            let head = format!("position[head_sha]={sha}");
            let start = format!("position[start_sha]={}", field(&refs, "base_sha"));
            let new_path = format!("position[new_path]={file}");
            let new_line = format!("position[new_line]={line}");
            call(
                forge,
                cwd,
                &[
                    "api",
                    "-X",
                    "POST",
                    &path,
                    "-f",
                    &body_field,
                    "-f",
                    "position[position_type]=text",
                    "-f",
                    &base,
                    "-f",
                    &head,
                    "-f",
                    &start,
                    "-f",
                    &new_path,
                    "-F",
                    &new_line,
                ],
            )
            .await?;
        }
        (Forge::GitLab, None, _, _) => {
            call(forge, cwd, &["mr", "note", &id, "--message", &request.body]).await?;
        }
        (Forge::Azure | Forge::Forgejo | Forge::Bitbucket, ..) => {
            return Err(forge.unsupported("comment"));
        }
    }
    Ok(())
}

pub async fn edit_comment(
    forge: Forge,
    cwd: &Path,
    number: u64,
    comment: &str,
    kind: &str,
    body: &str,
) -> Result<()> {
    let body_field = format!("body={body}");
    let path = match forge {
        Forge::GitHub if is_github_review(kind) => {
            format!("repos/{{owner}}/{{repo}}/pulls/comments/{comment}")
        }
        Forge::GitHub => format!("repos/{{owner}}/{{repo}}/issues/comments/{comment}"),
        Forge::GitLab => format!("projects/:id/merge_requests/{number}/notes/{comment}"),
        _ => return Err(forge.unsupported("edit comments")),
    };
    let method = if forge == Forge::GitHub {
        "PATCH"
    } else {
        "PUT"
    };
    call(forge, cwd, &["api", "-X", method, &path, "-f", &body_field])
        .await
        .map(|_| ())
}

pub async fn set_thread_resolved(
    forge: Forge,
    cwd: &Path,
    number: u64,
    thread: &str,
    resolved: bool,
) -> Result<()> {
    match forge {
        Forge::GitHub => {
            let mutation = if resolved {
                RESOLVE_MUTATION
            } else {
                UNRESOLVE_MUTATION
            };
            let query = format!("query={mutation}");
            let id = format!("id={thread}");
            call(forge, cwd, &["api", "graphql", "-f", &query, "-f", &id])
                .await
                .map(|_| ())
        }
        Forge::GitLab => {
            let path = format!("projects/:id/merge_requests/{number}/discussions/{thread}");
            let value = format!("resolved={resolved}");
            call(forge, cwd, &["api", "-X", "PUT", &path, "-F", &value])
                .await
                .map(|_| ())
        }
        _ => Err(forge.unsupported("resolve conversations")),
    }
}

fn gitlab_emoji(content: &str) -> &str {
    match content {
        "+1" => "thumbsup",
        "-1" => "thumbsdown",
        "laugh" => "laughing",
        "hooray" => "tada",
        other => other,
    }
}

pub async fn react(
    forge: Forge,
    cwd: &Path,
    number: u64,
    comment: &str,
    kind: &str,
    content: &str,
) -> Result<()> {
    const REACTIONS: &[&str] = &[
        "+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes",
    ];
    if !REACTIONS.contains(&content) {
        return Err(CoreError::Invalid("Choose a known reaction.".into()));
    }
    match forge {
        Forge::GitHub => {
            let scope = if is_github_review(kind) {
                "pulls"
            } else {
                "issues"
            };
            let path = format!("repos/{{owner}}/{{repo}}/{scope}/comments/{comment}/reactions");
            let value = format!("content={content}");
            call(forge, cwd, &["api", "-X", "POST", &path, "-f", &value])
                .await
                .map(|_| ())
        }
        Forge::GitLab => {
            let path = format!("projects/:id/merge_requests/{number}/notes/{comment}/award_emoji");
            let value = format!("name={}", gitlab_emoji(content));
            call(forge, cwd, &["api", "-X", "POST", &path, "-f", &value])
                .await
                .map(|_| ())
        }
        _ => Err(forge.unsupported("react")),
    }
}

/// The body of a GitHub review with line comments.
fn review_payload(event: &str, body: &str, comments: &[ReviewLineComment]) -> Value {
    json!({
        "event": event.to_uppercase(),
        "body": body,
        "comments": comments
            .iter()
            .map(|comment| json!({
                "path": comment.path,
                "line": comment.line,
                "side": "RIGHT",
                "body": comment.body,
            }))
            .collect::<Vec<_>>(),
    })
}

pub async fn submit_review(
    forge: Forge,
    cwd: &Path,
    number: u64,
    review: &SubmitReview,
) -> Result<()> {
    let id = number.to_string();
    let event = review.event.as_str();
    if !matches!(event, "approve" | "request_changes" | "comment") {
        return Err(CoreError::Invalid(
            "That review action is not available.".into(),
        ));
    }
    match forge {
        Forge::GitHub if review.comments.is_empty() => {
            let flag = format!("--{}", event.replace('_', "-"));
            call(
                forge,
                cwd,
                &["pr", "review", &id, &flag, "--body", &review.body],
            )
            .await?;
        }
        Forge::GitHub => {
            let path = format!("repos/{{owner}}/{{repo}}/pulls/{id}/reviews");
            let payload = review_payload(event, &review.body, &review.comments).to_string();
            call_input(
                forge,
                cwd,
                &["api", "-X", "POST", &path, "--input", "-"],
                &payload,
            )
            .await?;
        }
        Forge::GitLab => {
            for comment in &review.comments {
                let request = AddPullComment {
                    body: comment.body.clone(),
                    path: Some(comment.path.clone()),
                    line: Some(comment.line),
                    reply_to: None,
                };
                add_comment(forge, cwd, number, &request).await?;
            }
            match event {
                "approve" => {
                    call(forge, cwd, &["mr", "approve", &id]).await?;
                }
                "comment" if !review.body.is_empty() => {
                    call(forge, cwd, &["mr", "note", &id, "--message", &review.body]).await?;
                }
                "comment" => {}
                _ => {
                    return Err(CoreError::Invalid(
                        "That review action is not available.".into(),
                    ));
                }
            }
        }
        _ => return Err(forge.unsupported("review")),
    }
    Ok(())
}

fn joined(names: &[String]) -> Option<String> {
    (!names.is_empty()).then(|| names.join(","))
}

fn valid_names(names: &[String]) -> Result<()> {
    if names
        .iter()
        .any(|name| name.is_empty() || name.starts_with('-') || name.contains(','))
    {
        return Err(CoreError::Invalid("That name is not valid.".into()));
    }
    Ok(())
}

pub async fn set_reviewers(
    forge: Forge,
    cwd: &Path,
    number: u64,
    change: &SetPullPeople,
) -> Result<()> {
    valid_names(&change.add)?;
    valid_names(&change.remove)?;
    let id = number.to_string();
    match forge {
        Forge::GitHub => {
            let mut args = vec!["pr", "edit", id.as_str()];
            let (add, remove) = (joined(&change.add), joined(&change.remove));
            if let Some(add) = &add {
                args.extend(["--add-reviewer", add]);
            }
            if let Some(remove) = &remove {
                args.extend(["--remove-reviewer", remove]);
            }
            call(forge, cwd, &args).await.map(|_| ())
        }
        Forge::GitLab => {
            let names: Vec<String> = change
                .add
                .iter()
                .map(|name| format!("+{name}"))
                .chain(change.remove.iter().map(|name| format!("-{name}")))
                .collect();
            let names = names.join(",");
            call(forge, cwd, &["mr", "update", &id, "--reviewer", &names])
                .await
                .map(|_| ())
        }
        _ => Err(forge.unsupported("change reviewers")),
    }
}

pub async fn set_labels(
    forge: Forge,
    cwd: &Path,
    number: u64,
    change: &SetPullPeople,
) -> Result<()> {
    valid_names(&change.add)?;
    valid_names(&change.remove)?;
    let id = number.to_string();
    let (add, remove) = (joined(&change.add), joined(&change.remove));
    let (program, add_flag, remove_flag) = match forge {
        Forge::GitHub => (["pr", "edit"], "--add-label", "--remove-label"),
        Forge::GitLab => (["mr", "update"], "--label", "--unlabel"),
        _ => return Err(forge.unsupported("change labels")),
    };
    let mut args = vec![program[0], program[1], id.as_str()];
    if let Some(add) = &add {
        args.extend([add_flag, add]);
    }
    if let Some(remove) = &remove {
        args.extend([remove_flag, remove]);
    }
    call(forge, cwd, &args).await.map(|_| ())
}

pub async fn reviewer_candidates(forge: Forge, cwd: &Path) -> Result<Vec<PullCandidate>> {
    let (args, name): (&[&str], &str) = match forge {
        Forge::GitHub => (
            &[
                "api",
                "--paginate",
                "repos/{owner}/{repo}/assignees?per_page=100",
            ],
            "login",
        ),
        Forge::GitLab => (
            &["api", "--paginate", "projects/:id/members/all?per_page=100"],
            "username",
        ),
        _ => return Err(forge.unsupported("list reviewers")),
    };
    Ok(call_pages(forge, cwd, args)
        .await?
        .iter()
        .map(|person| PullCandidate {
            name: field(person, name).to_owned(),
            description: optional(person, "name"),
        })
        .collect())
}

pub async fn label_candidates(forge: Forge, cwd: &Path) -> Result<Vec<PullCandidate>> {
    let value = match forge {
        Forge::GitHub => {
            call_json(
                forge,
                cwd,
                &[
                    "label",
                    "list",
                    "--limit",
                    "200",
                    "--json",
                    "name,description",
                ],
            )
            .await?
        }
        Forge::GitLab => call_json(forge, cwd, &["label", "list", "--output", "json"]).await?,
        _ => return Err(forge.unsupported("list labels")),
    };
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .map(|label| PullCandidate {
            name: field(label, "name").to_owned(),
            description: optional(label, "description"),
        })
        .collect())
}

pub async fn update_pull(forge: Forge, cwd: &Path, number: u64, update: &UpdatePull) -> Result<()> {
    let id = number.to_string();
    if update
        .base
        .as_deref()
        .is_some_and(|base| base.starts_with('-'))
    {
        return Err(CoreError::Invalid(
            "That is not a valid branch name.".into(),
        ));
    }
    match forge {
        Forge::GitHub => {
            let mut args = vec!["pr", "edit", id.as_str()];
            for (flag, value) in [
                ("--title", &update.title),
                ("--body", &update.body),
                ("--base", &update.base),
            ] {
                if let Some(value) = value {
                    args.extend([flag, value.as_str()]);
                }
            }
            if args.len() > 3 {
                call(forge, cwd, &args).await?;
            }
            match update.draft {
                Some(true) => {
                    call(forge, cwd, &["pr", "ready", &id, "--undo"]).await?;
                }
                Some(false) => {
                    call(forge, cwd, &["pr", "ready", &id]).await?;
                }
                None => {}
            }
            if let Some(allowed) = update.maintainer_can_modify {
                let path = format!("repos/{{owner}}/{{repo}}/pulls/{id}");
                let value = format!("maintainer_can_modify={allowed}");
                call(forge, cwd, &["api", "-X", "PATCH", &path, "-F", &value]).await?;
            }
            Ok(())
        }
        Forge::GitLab => {
            let mut args = vec!["mr", "update", id.as_str(), "--yes"];
            for (flag, value) in [
                ("--title", &update.title),
                ("--description", &update.body),
                ("--target-branch", &update.base),
            ] {
                if let Some(value) = value {
                    args.extend([flag, value.as_str()]);
                }
            }
            match update.draft {
                Some(true) => args.push("--draft"),
                Some(false) => args.push("--ready"),
                None => {}
            }
            if update.maintainer_can_modify.is_some() {
                return Err(forge.unsupported("change maintainer edits"));
            }
            call(forge, cwd, &args).await.map(|_| ())
        }
        _ => Err(forge.unsupported("edit pull requests")),
    }
}

/// Azure's merge strategy words differ from everyone else's.
pub async fn merge(forge: Forge, cwd: &Path, number: u64, options: &MergePull) -> Result<()> {
    if !matches!(options.method.as_str(), "merge" | "squash" | "rebase") {
        return Err(CoreError::Invalid("Choose merge, squash or rebase.".into()));
    }
    let id = number.to_string();
    let body = options.body.as_ref().map(|body| {
        if options.strip_credits {
            strip_agent_credits(body)
        } else {
            body.clone()
        }
    });
    match forge {
        Forge::GitHub => {
            let flag = format!("--{}", options.method);
            let mut args = vec!["pr", "merge", id.as_str(), flag.as_str()];
            if options.auto {
                args.push("--auto");
            }
            if options.delete_branch {
                args.push("--delete-branch");
            }
            if let Some(subject) = &options.subject {
                args.extend(["--subject", subject]);
            }
            if let Some(body) = &body {
                args.extend(["--body", body]);
            }
            call(forge, cwd, &args).await.map(|_| ())
        }
        Forge::GitLab => {
            let mut args = vec!["mr", "merge", id.as_str(), "--yes"];
            match options.method.as_str() {
                "squash" => args.push("--squash"),
                "rebase" => args.push("--rebase"),
                _ => {}
            }
            if options.auto {
                args.push("--auto-merge");
            }
            if options.delete_branch {
                args.push("--remove-source-branch");
            }
            if let Some(body) = &body {
                args.extend(["--message", body]);
            }
            call(forge, cwd, &args).await.map(|_| ())
        }
        Forge::Azure => {
            let squash = if options.method == "squash" {
                "true"
            } else {
                "false"
            };
            let delete = if options.delete_branch {
                "true"
            } else {
                "false"
            };
            call(
                forge,
                cwd,
                &[
                    "repos",
                    "pr",
                    "update",
                    "--id",
                    &id,
                    "--detect",
                    "true",
                    "--status",
                    "completed",
                    "--squash",
                    squash,
                    "--delete-source-branch",
                    delete,
                    "--output",
                    "json",
                ],
            )
            .await
            .map(|_| ())
        }
        Forge::Forgejo => call(
            forge,
            cwd,
            &["pulls", "merge", "--style", &options.method, &id],
        )
        .await
        .map(|_| ()),
        Forge::Bitbucket => Err(forge.unsupported("merge")),
    }
}

/// Removes the lines coding agents add to a message, and the blank tail they leave.
pub fn strip_agent_credits(message: &str) -> String {
    let is_credit = |line: &str| {
        let lower = line.trim().to_lowercase();
        let agent = [
            "claude",
            "codex",
            "copilot",
            "cursor",
            "openai",
            "anthropic",
            "orbyn",
        ]
        .iter()
        .any(|name| lower.contains(name));
        (lower.starts_with("co-authored-by:") && agent)
            || (lower.contains("generated with") && agent)
    };
    let kept: Vec<&str> = message.lines().filter(|line| !is_credit(line)).collect();
    kept.join("\n").trim_end().to_owned()
}

pub async fn pull_action(
    forge: Forge,
    cwd: &Path,
    number: u64,
    action: &str,
    head: &str,
) -> Result<()> {
    let id = number.to_string();
    let args: Vec<String> = match (forge, action) {
        (Forge::GitHub, "close") => vec!["pr".into(), "close".into(), id],
        (Forge::GitHub, "reopen") => vec!["pr".into(), "reopen".into(), id],
        (Forge::GitHub, "revert") => vec!["pr".into(), "revert".into(), id],
        (Forge::GitHub, "update_branch") => vec!["pr".into(), "update-branch".into(), id],
        (Forge::GitHub, "rebase") => {
            vec!["pr".into(), "update-branch".into(), id, "--rebase".into()]
        }
        (Forge::GitHub, "delete_branch") => vec![
            "api".into(),
            "-X".into(),
            "DELETE".into(),
            format!("repos/{{owner}}/{{repo}}/git/refs/heads/{head}"),
        ],
        (Forge::GitLab, "close") => vec!["mr".into(), "close".into(), id],
        (Forge::GitLab, "reopen") => vec!["mr".into(), "reopen".into(), id],
        (Forge::GitLab, "rebase") => vec!["mr".into(), "rebase".into(), id],
        (Forge::Azure, "close") => vec![
            "repos".into(),
            "pr".into(),
            "update".into(),
            "--id".into(),
            id,
            "--detect".into(),
            "true".into(),
            "--status".into(),
            "abandoned".into(),
        ],
        (Forge::Azure, "reopen") => vec![
            "repos".into(),
            "pr".into(),
            "update".into(),
            "--id".into(),
            id,
            "--detect".into(),
            "true".into(),
            "--status".into(),
            "active".into(),
        ],
        (Forge::Forgejo, "close") => vec!["pulls".into(), "close".into(), id],
        (Forge::Forgejo, "reopen") => vec!["pulls".into(), "reopen".into(), id],
        (_, "close" | "reopen" | "revert" | "update_branch" | "rebase" | "delete_branch") => {
            return Err(forge.unsupported(&format!("{} this", action.replace('_', " "))));
        }
        _ => return Err(CoreError::Invalid("Unknown pull request action.".into())),
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    call(forge, cwd, &args).await.map(|_| ())
}

pub async fn create_pull(
    forge: Forge,
    cwd: &Path,
    branch: &str,
    title: &str,
    body: &str,
    base: Option<&str>,
) -> Result<String> {
    let mut args: Vec<&str> = match forge {
        Forge::GitHub => vec![
            "pr", "create", "--title", title, "--body", body, "--head", branch,
        ],
        Forge::GitLab => vec![
            "mr",
            "create",
            "--title",
            title,
            "--description",
            body,
            "--source-branch",
            branch,
            "--yes",
        ],
        Forge::Azure => vec![
            "repos",
            "pr",
            "create",
            "--detect",
            "true",
            "--title",
            title,
            "--description",
            body,
            "--source-branch",
            branch,
            "--output",
            "json",
        ],
        Forge::Forgejo => vec![
            "pulls",
            "create",
            "--title",
            title,
            "--description",
            body,
            "--head",
            branch,
        ],
        Forge::Bitbucket => return Err(forge.unsupported("open pull requests")),
    };
    if let Some(base) = base {
        args.push(match forge {
            Forge::GitHub | Forge::Forgejo => "--base",
            Forge::GitLab => "--target-branch",
            Forge::Azure | Forge::Bitbucket => "--target-branch",
        });
        args.push(base);
    }
    let output = call(forge, cwd, &args).await?;
    if forge == Forge::Azure {
        let value: Value = serde_json::from_str(&output)?;
        return Ok(format!("azure:{}", id_of(&value, "pullRequestId")));
    }
    Ok(output
        .lines()
        .rfind(|line| line.trim_start().starts_with("http"))
        .unwrap_or(&output)
        .trim()
        .to_owned())
}

pub fn number_from_url(url: &str) -> Option<u64> {
    url.trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()?
        .parse()
        .ok()
}

/// Creates a remote from a local repository with this forge's CLI and pushes.
pub async fn publish(forge: Forge, cwd: &Path, name: &str, private: bool) -> Result<()> {
    let visibility = if private { "--private" } else { "--public" };
    match forge {
        Forge::GitHub => call(
            forge,
            cwd,
            &[
                "repo", "create", name, visibility, "--source", ".", "--push",
            ],
        )
        .await
        .map(|_| ()),
        Forge::GitLab => call(
            forge,
            cwd,
            &[
                "repo",
                "create",
                name,
                visibility,
                "--defaultBranch",
                "main",
            ],
        )
        .await
        .map(|_| ()),
        _ => Err(forge.unsupported("publish a repository")),
    }
}

/// What the CLI says about itself, without touching a token.
pub async fn forge_status(forge: Forge) -> orbyn_contracts::ForgeStatus {
    let cwd = std::env::temp_dir();
    let mut status = orbyn_contracts::ForgeStatus {
        id: forge.id().to_owned(),
        name: forge.name().to_owned(),
        program: forge.program().map(str::to_owned),
        installed: false,
        version: None,
        signed_in: false,
        accounts: Vec::new(),
        problem: None,
    };
    let Some(program) = forge.program() else {
        status.problem =
            Some("Bitbucket has no command line tool, and Orbyn holds no forge tokens.".into());
        return status;
    };
    if resolve(program).is_none() {
        status.problem = Some(format!("Install {program} and sign in to it to use this."));
        return status;
    }
    status.installed = true;
    let version_flag: &[&str] = if forge == Forge::Azure {
        &["version", "--output", "json"]
    } else {
        &["--version"]
    };
    if let Ok(output) = spawn(forge, &cwd, version_flag, None).await {
        status.version = output.stdout.lines().next().map(str::to_owned);
    }
    let auth: &[&str] = match forge {
        Forge::GitHub => &["auth", "status"],
        Forge::GitLab => &["auth", "status"],
        Forge::Azure => &["account", "show", "--output", "json"],
        Forge::Forgejo => &["login", "list", "--output", "json"],
        Forge::Bitbucket => return status,
    };
    if let Ok(output) = spawn(forge, &cwd, auth, None).await {
        status.signed_in = output.success;
        status.accounts = auth_accounts(&format!("{}\n{}", output.stdout, output.stderr));
    }
    status
}

/// Who the CLI is signed in as, so a watch can skip your own comments.
pub async fn viewer(forge: Forge, cwd: &Path) -> Option<String> {
    let args: &[&str] = match forge {
        Forge::GitHub | Forge::GitLab => &["api", "user"],
        _ => return None,
    };
    person(&call_json(forge, cwd, args).await.ok()?)
}

/// Picks `account NAME` out of `gh auth status`; tokens are never printed by it.
fn auth_accounts(output: &str) -> Vec<String> {
    let mut accounts = Vec::new();
    for line in output.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if let Some(index) = words.iter().position(|word| *word == "account")
            && let Some(name) = words.get(index + 1)
        {
            let name = name.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
            if !name.is_empty() && !accounts.iter().any(|known| known == name) {
                accounts.push(name.to_owned());
            }
        }
    }
    accounts
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
        assert_eq!(
            Forge::of_remote("https://dev.azure.com/o/p/_git/r"),
            Forge::Azure
        );
        assert_eq!(
            Forge::of_remote("https://o.visualstudio.com/p/_git/r"),
            Forge::Azure
        );
        assert_eq!(
            Forge::of_remote("git@bitbucket.org:a/b.git"),
            Forge::Bitbucket
        );
        assert_eq!(Forge::of_remote("https://codeberg.org/a/b"), Forge::Forgejo);
        assert_eq!(
            Forge::of_remote("https://git.corp.example/a/b"),
            Forge::GitHub
        );
    }

    #[test]
    fn every_forge_reads_into_one_shape() {
        let hub = json!({
            "number": 7, "title": "T", "url": "https://x/7", "state": "MERGED",
            "headRefName": "feat", "baseRefName": "main", "author": { "login": "a" },
            "isDraft": true, "reviewDecision": "APPROVED", "labels": [{ "name": "bug" }],
            "statusCheckRollup": [{ "status": "COMPLETED", "conclusion": "FAILURE" }],
        });
        let pull = parse_pull(&hub).unwrap();
        assert_eq!(pull.state, "merged");
        assert_eq!(pull.author.as_deref(), Some("a"));
        assert!(pull.draft);
        assert_eq!(pull.labels, ["bug"]);
        assert_eq!(pull.review_state.as_deref(), Some("approved"));
        assert_eq!(pull.checks_state.as_deref(), Some("fail"));
        let lab = json!({
            "iid": 9, "title": "T", "web_url": "https://x/9", "state": "opened",
            "source_branch": "feat", "target_branch": "main", "author": { "username": "b" },
            "labels": ["ui"],
        });
        let pull = parse_pull(&lab).unwrap();
        assert_eq!((pull.number, pull.state.as_str()), (9, "open"));
        assert_eq!(pull.head, "feat");
        assert_eq!(pull.labels, ["ui"]);
        let azure = json!({
            "pullRequestId": 4, "title": "T", "status": "completed",
            "sourceRefName": "refs/heads/feat", "targetRefName": "refs/heads/main",
            "createdBy": { "displayName": "C" },
        });
        let pull = parse_pull(&azure).unwrap();
        assert_eq!(
            (pull.state.as_str(), pull.head.as_str(), pull.base.as_str()),
            ("merged", "feat", "main")
        );
        assert_eq!(pull.author.as_deref(), Some("C"));
        let forgejo = json!({ "index": 5, "title": "T", "state": "open", "head": "h", "base": "b", "poster": "d" });
        assert_eq!(parse_pull(&forgejo).unwrap().number, 5);
        assert!(parse_pull(&json!({ "title": "no number" })).is_none());
    }

    #[test]
    fn pull_numbers_come_from_the_url() {
        assert_eq!(
            number_from_url("https://github.com/a/b/pull/12\n".trim()),
            Some(12)
        );
        assert_eq!(number_from_url("https://x/a/-/merge_requests/3/"), Some(3));
        assert_eq!(number_from_url("azure:44"), Some(44));
        assert_eq!(number_from_url("not a url"), None);
    }

    #[test]
    fn credit_lines_leave_the_message_and_other_lines_stay() {
        let message = "Fix the thing\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\
                       Co-authored-by: Sam <sam@example.com>\n\n🤖 Generated with [Claude Code](x)\n";
        assert_eq!(
            strip_agent_credits(message),
            "Fix the thing\n\nCo-authored-by: Sam <sam@example.com>"
        );
    }

    #[test]
    fn check_words_come_from_status_and_conclusion() {
        assert_eq!(check_state("COMPLETED", "SUCCESS"), "pass");
        assert_eq!(check_state("COMPLETED", "TIMED_OUT"), "fail");
        assert_eq!(check_state("IN_PROGRESS", ""), "pending");
        assert_eq!(check_state("SUCCESS", ""), "pass");
        assert_eq!(check_state("failed", ""), "fail");
        assert_eq!(
            rollup(["pass".into(), "pending".into()].into_iter()),
            "pending"
        );
        assert_eq!(rollup(std::iter::empty()), "none");
    }

    #[test]
    fn a_review_with_lines_keeps_every_line() {
        let payload = review_payload(
            "request_changes",
            "See notes",
            &[ReviewLineComment {
                path: "a.rs".into(),
                line: 3,
                body: "Hm".into(),
            }],
        );
        assert_eq!(payload["event"], "REQUEST_CHANGES");
        assert_eq!(payload["comments"][0]["side"], "RIGHT");
    }

    #[test]
    fn gitlab_discussions_split_into_comments_and_threads() {
        let discussions = vec![
            json!({ "id": "d1", "notes": [{
                "id": 1, "body": "fix", "resolvable": true, "resolved": false,
                "author": { "username": "a" },
                "position": { "new_path": "x.rs", "new_line": 4 },
            }]}),
            json!({ "id": "d2", "notes": [{ "id": 2, "body": "hello", "resolvable": false }]}),
            json!({ "id": "d3", "notes": [{ "id": 3, "body": "merged", "system": true }]}),
        ];
        let conversation = gitlab_conversation(&discussions);
        assert_eq!(conversation.threads.len(), 1);
        assert_eq!(conversation.threads[0].line, Some(4));
        assert_eq!(conversation.comments.len(), 1);
    }

    #[test]
    fn github_threads_are_read_from_graphql() {
        let reply = json!({ "data": { "repository": { "pullRequest": { "reviewThreads": { "nodes": [{
            "id": "T1", "isResolved": true, "path": "a.rs", "line": 2,
            "comments": { "nodes": [{ "databaseId": 11, "body": "b", "author": { "login": "z" } }] },
        }]}}}}});
        let threads = github_threads(&reply);
        assert!(threads[0].resolved);
        assert_eq!(threads[0].comments[0].id, "11");
        assert_eq!(threads[0].comments[0].author.as_deref(), Some("z"));
    }

    #[test]
    fn accounts_are_read_without_any_token() {
        let output =
            "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Token: gho_****\n";
        assert_eq!(auth_accounts(output), ["octo"]);
    }
}
