//! Engine drivers. A driver turns one engine's protocol into `EngineEvent`s and
//! carries `PermissionRequest`s back and forth. It holds no store, policy or UI
//! logic: the run manager owns all of that.

pub mod acp;
pub mod agui;
pub mod claude;
pub mod codex;
mod pipes;
pub mod rpc;
pub mod terminal;

use std::path::PathBuf;

use async_trait::async_trait;
use orbyn_contracts::{
    ActionKind, AgUiEvent, AuthState, EngineCapabilities, EngineTier, InstallerKind,
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::approvals::Verdict;
use crate::error::Result;

/// The per-run MCP server's name in every engine. It is distinct from `orbyn`
/// because a user's own engine config can already define a server by that name,
/// and an engine merges same-named entries.
pub const MCP_SERVER_NAME: &str = "orbyn_engineering";

/// Claude's name for this server's permission tool.
pub const CLAUDE_APPROVE_TOOL: &str = "mcp__orbyn_engineering__approve";

#[derive(Clone, Debug)]
pub struct EngineDescriptor {
    pub id: String,
    pub name: String,
    pub tier: EngineTier,
    pub capabilities: EngineCapabilities,
}

/// What a read-only probe learned. Probing never opens a session.
#[derive(Clone, Debug, Default)]
pub struct EngineProbe {
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub auth: Option<AuthState>,
    pub problem: Option<String>,
    pub sign_in_command: Option<String>,
}

/// An update through the installer that provably owns the binary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdatePlan {
    pub installer: InstallerKind,
    pub program: String,
    pub args: Vec<String>,
    pub lock_key: String,
}

impl UpdatePlan {
    pub fn display(&self) -> String {
        std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Everything a driver needs for one run.
#[derive(Clone, Debug)]
pub struct RunSpec {
    pub run_id: String,
    pub thread_id: String,
    /// Where the engine process starts: the workspace root for native engines,
    /// so they discover the library themselves; the checkout for all others.
    pub cwd: PathBuf,
    /// The selected checkout, which is the only place this run may write.
    pub checkout: PathBuf,
    /// The prompt, with its workspace context already in front of it.
    pub prompt: String,
    /// The prompt alone, for engines that cannot take context.
    pub user_prompt: String,
    pub model: Option<String>,
    /// The engine's own session id from an earlier run of this thread.
    pub resume: Option<String>,
    /// Per-run MCP URL; the token inside it is revoked at run end.
    pub mcp_url: Option<String>,
    /// Private scratch directory for this run, removed at run end.
    pub run_dir: PathBuf,
}

/// An action the engine needs answered. Dropping `reply` is a denial.
#[derive(Debug)]
pub struct PermissionRequest {
    pub kind: ActionKind,
    pub target: String,
    pub summary: String,
    pub detail: Value,
    /// Files a write touches; empty means `target` names the file.
    pub paths: Vec<String>,
    pub reply: oneshot::Sender<Verdict>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EngineOutcome {
    Completed,
    Cancelled,
    Failed(String),
}

#[derive(Debug)]
pub enum EngineEvent {
    Agui(AgUiEvent),
    /// The engine's resumable session id.
    Session(String),
    Permission(PermissionRequest),
    Finished(EngineOutcome),
}

impl From<AgUiEvent> for EngineEvent {
    fn from(event: AgUiEvent) -> Self {
        Self::Agui(event)
    }
}

/// A started engine. Cancelling asks the driver to stop; the task owns the
/// process, so ending it or dropping it cleans up the process tree.
pub struct RunHandle {
    pub cancel: CancellationToken,
    pub task: JoinHandle<()>,
}

#[async_trait]
pub trait EngineDriver: Send + Sync {
    fn descriptor(&self) -> EngineDescriptor;

    async fn probe(&self) -> EngineProbe;

    /// The update this driver would run for `probe`, when ownership is provable.
    async fn update_plan(&self, _probe: &EngineProbe) -> Option<UpdatePlan> {
        None
    }

    /// A manual update hint for when no plan exists.
    fn manual_hint(&self) -> Option<String> {
        None
    }

    /// The latest version, for an engine with its own way of knowing.
    async fn latest_version(&self) -> Option<String> {
        None
    }

    /// The registry package name used to look up the latest version.
    fn npm_package(&self) -> Option<&str> {
        None
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle>;

    /// One prompt, one reply, no tools and no session. This spends the user's
    /// engine usage, so it runs only when they ask for it.
    async fn one_shot(&self, _prompt: &str, _model: Option<&str>) -> Result<String> {
        Err(crate::error::CoreError::Unsupported(
            "This engine cannot answer a one-off request.".into(),
        ))
    }
}

/// Sends a request to the run owner and waits for its verdict. A closed channel
/// or dropped reply is a denial.
pub(crate) async fn ask(
    events: &mpsc::Sender<EngineEvent>,
    kind: ActionKind,
    target: String,
    summary: String,
    detail: Value,
) -> Verdict {
    ask_paths(events, kind, target, summary, detail, Vec::new()).await
}

/// `ask` for a write with known file paths.
pub(crate) async fn ask_paths(
    events: &mpsc::Sender<EngineEvent>,
    kind: ActionKind,
    target: String,
    summary: String,
    detail: Value,
    paths: Vec<String>,
) -> Verdict {
    let (reply, verdict) = oneshot::channel();
    let request = PermissionRequest {
        kind,
        target,
        summary,
        detail,
        paths,
        reply,
    };
    if events.send(EngineEvent::Permission(request)).await.is_err() {
        return Verdict::Deny("The run has ended.".to_owned());
    }
    verdict
        .await
        .unwrap_or_else(|_| Verdict::Deny("The run has ended.".to_owned()))
}

/// Summarizes a unified diff for the activity log as `{files: [...]}`.
pub(crate) fn diff_activity(diff: &str) -> Value {
    let mut files: Vec<(String, u32, u32)> = Vec::new();
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let path = rest.rsplit(" b/").next().unwrap_or(rest).to_owned();
            files.push((path, 0, 0));
        } else if let Some(file) = files.last_mut() {
            if line.starts_with('+') && !line.starts_with("+++") {
                file.1 += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                file.2 += 1;
            }
        }
    }
    serde_json::json!({
        "files": files
            .into_iter()
            .map(|(path, additions, deletions)| serde_json::json!({
                "path": path,
                "additions": additions,
                "deletions": deletions,
            }))
            .collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_activity_counts_changed_lines() {
        let diff = "diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1,2 @@\n-a\n+b\n+c\n";
        assert_eq!(
            diff_activity(diff),
            serde_json::json!({"files":[{"path":"x.rs","additions":2,"deletions":1}]})
        );
    }

    #[tokio::test]
    async fn closed_channel_is_a_denial() {
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        let verdict = ask(
            &sender,
            ActionKind::Tool,
            "t".into(),
            "s".into(),
            Value::Null,
        )
        .await;
        assert!(!verdict.is_allowed());
    }

    #[tokio::test]
    async fn dropped_reply_is_a_denial() {
        let (sender, mut receiver) = mpsc::channel(1);
        let asker = tokio::spawn(async move {
            ask(
                &sender,
                ActionKind::Tool,
                "t".into(),
                "s".into(),
                Value::Null,
            )
            .await
        });
        drop(receiver.recv().await);
        assert!(!asker.await.unwrap().is_allowed());
    }
}
