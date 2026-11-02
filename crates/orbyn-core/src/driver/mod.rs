//! Engine drivers. A driver turns one engine's protocol into `EngineEvent`s and
//! carries `PermissionRequest`s back and forth. It holds no store, policy or UI
//! logic: the run manager owns all of that.

pub mod acp;
mod acp_sessions;
pub mod agui;
pub mod claude;
pub mod codex;
pub mod diagnostics;
mod pipes;
pub mod rpc;
pub mod terminal;

use std::collections::BTreeMap;
use std::path::PathBuf;

use async_trait::async_trait;
use orbyn_contracts::{
    ActionKind, AgUiEvent, AuthState, EngineAgent, EngineCapabilities, EngineTier, InstallerKind,
    ModelInfo, ModelOption, ModelOptionValue,
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::approvals::Verdict;
use crate::error::Result;
use crate::questions::Answers;

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
    pub kind: RunKind,
    pub mode: orbyn_contracts::PermissionMode,
    /// Plan mode: the engine may read and propose, not change anything.
    pub plan: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Choices beyond model and effort, by `ModelOption` id.
    pub options: BTreeMap<String, String>,
    /// The engine's own session id from an earlier run of this thread.
    pub resume: Option<String>,
    /// Per-run MCP URL; the token inside it is revoked at run end.
    pub mcp_url: Option<String>,
    /// Private scratch directory for this run, removed at run end.
    pub run_dir: PathBuf,
}

/// Historical replay captured without admitting a run or sending a prompt.
#[derive(Debug)]
pub struct NativeSessionReplay {
    pub events: Vec<AgUiEvent>,
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

/// A question for the person. Dropping `reply` is a dismissal.
#[derive(Debug)]
pub struct QuestionAsk {
    pub questions: Vec<orbyn_contracts::Question>,
    pub reply: oneshot::Sender<Option<Answers>>,
}

/// What an engine says it offers, and where the list came from: `engine` or
/// `documented`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelCatalog {
    pub source: &'static str,
    pub models: Vec<ModelInfo>,
    /// Choices that apply to every model.
    pub options: Vec<ModelOption>,
    /// Why this is a stand-in for what the engine would have said.
    pub fallback: Option<String>,
    /// Slash commands, as `(name, description)`.
    pub commands: Vec<(String, String)>,
    pub agents: Vec<EngineAgent>,
    pub output_styles: Vec<String>,
    pub output_style: Option<String>,
}

impl ModelCatalog {
    /// A list the engine itself gave.
    pub fn engine(models: Vec<ModelInfo>) -> Self {
        Self {
            source: "engine",
            models,
            ..Self::default()
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum EngineOutcome {
    Completed,
    Cancelled,
    Failed(String),
    /// The engine does not have the session this run tried to resume.
    SessionLost,
}

#[derive(Debug)]
pub enum EngineEvent {
    Agui(AgUiEvent),
    /// The engine refused a message sent mid-turn.
    SteerFailed(String),
    /// The engine says the turn stopped on a usage or rate limit.
    Limited {
        /// Unix seconds, when it says.
        resets_at: Option<i64>,
    },
    /// The engine's resumable session id.
    Session(String),
    Permission(PermissionRequest),
    /// A raw item for the inspector.
    Item(ItemRecord),
    /// Files a tool just finished writing.
    Files(Vec<String>),
    Usage(orbyn_contracts::ThreadUsage),
    /// Slash commands the engine says it has, as `(name, description)`.
    Commands(Vec<(String, String)>),
    Question(QuestionAsk),
    /// The goal as the engine reports it; `None` means it was cleared.
    Goal(Option<orbyn_contracts::ThreadGoal>),
    Finished(EngineOutcome),
}

/// A plan an engine proposed, as one finished assistant message in the
/// `<proposed_plan>` form clients already show as a card. Being text, it also reaches
/// a handoff and message search. A closing tag inside the plan is broken so it cannot
/// end the card early.
pub(crate) fn proposed_plan_events(id: &str, plan: &str) -> Vec<EngineEvent> {
    let plan = plan.trim();
    if plan.is_empty() {
        return Vec::new();
    }
    let message_id = format!("proposed-plan-{id}");
    let plan = plan.replace("</proposed_plan>", "<\\/proposed_plan>");
    vec![
        AgUiEvent::TextMessageStart {
            message_id: message_id.clone(),
            role: "assistant".into(),
        }
        .into(),
        AgUiEvent::TextMessageContent {
            message_id: message_id.clone(),
            delta: format!("<proposed_plan>\n{plan}\n</proposed_plan>"),
        }
        .into(),
        AgUiEvent::TextMessageEnd { message_id }.into(),
    ]
}

#[derive(Clone, Debug, PartialEq)]
pub struct ItemRecord {
    pub id: String,
    pub kind: String,
    pub raw: Value,
    pub exit_code: Option<i64>,
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
    /// Takes steering text while the run works, for engines that accept it.
    pub input: Option<mpsc::UnboundedSender<String>>,
}

/// What this run asks of the engine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunKind {
    Turn,
    /// `/compact`.
    Compact,
    Goal(GoalAction),
}

/// What a `/goal` message asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GoalAction {
    Set(String),
    Clear,
    Pause,
    Resume,
}

impl RunKind {
    pub fn parse(prompt: &str) -> Self {
        let text = prompt.trim();
        if text == "/compact" {
            return Self::Compact;
        }
        match text.strip_prefix("/goal ").map(str::trim) {
            Some("clear") => Self::Goal(GoalAction::Clear),
            Some("pause") => Self::Goal(GoalAction::Pause),
            Some("resume") => Self::Goal(GoalAction::Resume),
            Some(objective) if !objective.is_empty() => {
                Self::Goal(GoalAction::Set(objective.to_owned()))
            }
            _ => Self::Turn,
        }
    }
}

#[async_trait]
pub trait EngineDriver: Send + Sync {
    fn descriptor(&self) -> EngineDescriptor;

    /// Local-process drivers resolve their configured executable here without
    /// starting it. Endpoint and synthetic drivers have no executable to check.
    fn check_launch_available(&self) -> Result<()> {
        Ok(())
    }

    async fn native_session_capabilities(
        &self,
    ) -> Result<Option<orbyn_contracts::AcpSessionCapabilities>> {
        Ok(None)
    }

    async fn list_native_sessions(
        &self,
        _cwd: &std::path::Path,
        _cursor: Option<&str>,
    ) -> Result<orbyn_contracts::AcpNativeSessionPage> {
        Err(crate::error::CoreError::Unsupported(
            "This engine cannot list native sessions.".into(),
        ))
    }

    async fn load_native_session(
        &self,
        _cwd: &std::path::Path,
        _session_id: &str,
    ) -> Result<NativeSessionReplay> {
        Err(crate::error::CoreError::Unsupported(
            "This engine cannot load native sessions.".into(),
        ))
    }

    async fn delete_native_session(&self, _cwd: &std::path::Path, _session_id: &str) -> Result<()> {
        Err(crate::error::CoreError::Unsupported(
            "This engine cannot delete native sessions.".into(),
        ))
    }

    async fn probe(&self) -> EngineProbe;

    /// The engine this is, whatever it is called here: an instance of Claude is run,
    /// gated and limited as Claude.
    fn family(&self) -> String {
        self.descriptor().id
    }

    /// This driver under an instance's id, name and program, for a native driver.
    /// Every other engine is rebuilt from its launch instead.
    fn instance(
        &self,
        _instance: &orbyn_contracts::ProviderInstance,
    ) -> Option<std::sync::Arc<dyn EngineDriver>> {
        None
    }

    /// True when a relative path in this engine's tool calls means the checkout.
    /// Claude runs at the library, so its relative paths mean the library.
    fn resolves_from_checkout(&self) -> bool {
        true
    }

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

    /// Subscription limits, when the engine reports them without Orbyn touching
    /// a credential. Reading them spends no model usage.
    async fn limits(&self) -> Result<Option<Value>> {
        Ok(None)
    }

    /// Models this engine offers, from the engine itself where it can say.
    /// `Ok(None)` means it has no way to report them.
    async fn models(&self) -> Result<Option<ModelCatalog>> {
        Ok(None)
    }

    /// What a cached list depends on. An engine with a key keeps its list until the
    /// key changes; without one the list simply ages out.
    async fn catalog_key(&self) -> Option<String> {
        None
    }

    /// The vendor's own sign-in command, to name when a run fails for want of a login.
    fn sign_in_command(&self) -> Option<&str> {
        None
    }

    /// True when a value set on one turn stays for the next unless it is replaced,
    /// so each run has to state the catalog's default instead of leaving it out.
    fn keeps_turn_overrides(&self) -> bool {
        false
    }

    /// One prompt, one reply, no tools and no session. This spends the user's
    /// engine usage, so a caller that does so unasked needs a setting and a row in
    /// the network list.
    async fn one_shot(&self, _prompt: &str, _model: Option<&str>) -> Result<String> {
        Err(crate::error::CoreError::Unsupported(
            "This engine cannot answer a one-off request.".into(),
        ))
    }
}

/// An `effort` option from the levels a model reports, in its order.
pub(crate) fn effort_option<'a>(
    levels: impl IntoIterator<Item = &'a str>,
    default: Option<&str>,
) -> ModelOption {
    ModelOption {
        id: crate::selection::EFFORT.into(),
        label: "Effort".into(),
        values: levels
            .into_iter()
            .map(|id| ModelOptionValue {
                id: id.to_owned(),
                label: effort_label(id),
                default: Some(id) == default,
                description: None,
            })
            .collect(),
    }
}

fn effort_label(id: &str) -> String {
    match id {
        "xhigh" => "Extra high".to_owned(),
        other => {
            let mut chars = other.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            })
        }
    }
}

/// A private empty folder for asking an engine what it offers, so no project's
/// config applies. It goes when the probe is done.
pub(crate) struct ProbeDir(PathBuf);

impl ProbeDir {
    pub(crate) fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("orbyn-probe-{}", crate::util::new_id()));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for ProbeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
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

/// Puts questions to the person. A closed channel or dropped reply is no answer.
pub(crate) async fn ask_question(
    events: &mpsc::Sender<EngineEvent>,
    questions: Vec<orbyn_contracts::Question>,
) -> Option<Answers> {
    let (reply, answer) = oneshot::channel();
    let ask = QuestionAsk { questions, reply };
    events.send(EngineEvent::Question(ask)).await.ok()?;
    answer.await.ok().flatten()
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
    fn slash_commands_are_recognized_only_when_exact() {
        assert_eq!(RunKind::parse(" /compact "), RunKind::Compact);
        assert_eq!(
            RunKind::parse("/goal tests pass"),
            RunKind::Goal(GoalAction::Set("tests pass".into()))
        );
        assert_eq!(
            RunKind::parse("/goal clear"),
            RunKind::Goal(GoalAction::Clear)
        );
        assert_eq!(
            RunKind::parse("/goal pause"),
            RunKind::Goal(GoalAction::Pause)
        );
        assert_eq!(
            RunKind::parse("/goal resume"),
            RunKind::Goal(GoalAction::Resume)
        );
        assert_eq!(RunKind::parse("/goal"), RunKind::Turn);
        assert_eq!(RunKind::parse("/compactly please"), RunKind::Turn);
        assert_eq!(RunKind::parse("please /compact"), RunKind::Turn);
    }

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
