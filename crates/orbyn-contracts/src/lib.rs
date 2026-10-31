//! Wire types shared by the service and the UI. Timestamps are RFC 3339 UTC
//! strings and ids are opaque strings. `cargo test -p orbyn-contracts
//! export_bindings` regenerates `web/src/generated`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

macro_rules! wire {
    ($item:item) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
        #[ts(export, export_to = "../../../web/src/generated/")]
        $item
    };
}

macro_rules! wire_enum {
    ($item:item) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
        #[serde(rename_all = "snake_case")]
        #[ts(export, export_to = "../../../web/src/generated/")]
        $item
    };
}

wire! {
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Engines refuse to start until a person trusts this folder.
    pub trusted: bool,
    pub is_git: bool,
    pub created_at: String,
}
}

wire! {
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub engine: String,
    pub model: Option<String>,
    pub cwd: String,
    pub worktree: Option<Worktree>,
    pub skill_profile: Option<String>,
    pub active_run: Option<Run>,
    pub last_run_state: Option<RunState>,
    pub created_at: String,
    pub updated_at: String,
    /// Always present from the service; optional so older payloads still parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lifecycle: Option<ThreadLifecycle>,
}
}

wire! {
pub struct ThreadLifecycle {
    pub pinned_at: Option<String>,
    pub archived_at: Option<String>,
    pub settled_at: Option<String>,
    pub snoozed_until: Option<String>,
    pub unread: bool,
    /// `None` follows the settings; `Some` is the thread's own choice.
    pub auto_settle: Option<bool>,
    /// Lower sorts first. Thread activity never changes it.
    pub position: f64,
    pub parent_thread_id: Option<String>,
    /// `fork`, `side` or `subagent` when `parent_thread_id` is set.
    pub relation: Option<String>,
}
}

wire! {
/// `PATCH /api/threads/:id`. Absent fields are left alone.
#[derive(Default)]
pub struct UpdateThread {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub settled: Option<bool>,
    /// RFC 3339 time in the future.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snoozed_until: Option<String>,
    /// True ends a snooze early.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wake: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unread: Option<bool>,
    /// `null` clears the thread's own choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_settle: Option<AutoSettleChoice>,
}
}

wire_enum! {
pub enum AutoSettleChoice {
    Inherit,
    Enabled,
    Disabled,
}
}

wire! {
pub struct ReorderThreads {
    /// Thread ids in their new order. Ids left out keep their position.
    pub ids: Vec<String>,
}
}

wire! {
pub struct AutoSettleSettings {
    /// Idle days before settling; `None` turns the idle rule off.
    pub after_days: Option<u32>,
    pub on_merge: bool,
    pub keep_pull_requests: bool,
}
}

wire! {
pub struct SnoozePreset {
    pub label: String,
    /// Minutes from now, up to 30 days.
    pub minutes: u32,
}
}

wire! {
/// Service-wide settings. Fields only ever get added, with defaults.
pub struct ServerSettings {
    pub auto_settle: AutoSettleSettings,
    pub snooze_presets: Vec<SnoozePreset>,
    pub title_instructions: Option<String>,
}
}

wire! {
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub base: String,
}
}

wire_enum! {
pub enum RunState {
    Admitted,
    Starting,
    Running,
    AwaitingApproval,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
}

impl RunState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

wire! {
pub struct Run {
    pub id: String,
    pub thread_id: String,
    pub state: RunState,
    pub error: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}
}

/// AG-UI 1.0 event subset. Field names match `spec/1.0/schema.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(export, export_to = "../../../web/src/generated/")]
pub enum AgUiEvent {
    #[serde(rename_all = "camelCase")]
    RunStarted { thread_id: String, run_id: String },
    #[serde(rename_all = "camelCase")]
    RunFinished {
        thread_id: String,
        run_id: String,
        /// `{type: "success" | "cancelled"}` or `{type: "interrupt", interrupts}`.
        #[serde(skip_serializing_if = "Option::is_none")]
        outcome: Option<Value>,
    },
    #[serde(rename_all = "camelCase")]
    RunError {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TextMessageStart { message_id: String, role: String },
    #[serde(rename_all = "camelCase")]
    TextMessageContent { message_id: String, delta: String },
    #[serde(rename_all = "camelCase")]
    TextMessageEnd { message_id: String },
    #[serde(rename_all = "camelCase")]
    ReasoningMessageStart { message_id: String, role: String },
    #[serde(rename_all = "camelCase")]
    ReasoningMessageContent { message_id: String, delta: String },
    #[serde(rename_all = "camelCase")]
    ReasoningMessageEnd { message_id: String },
    #[serde(rename_all = "camelCase")]
    ToolCallStart {
        tool_call_id: String,
        tool_call_name: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallArgs { tool_call_id: String, delta: String },
    #[serde(rename_all = "camelCase")]
    ToolCallEnd { tool_call_id: String },
    #[serde(rename_all = "camelCase")]
    ToolCallResult {
        message_id: String,
        tool_call_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ActivitySnapshot {
        message_id: String,
        activity_type: String,
        content: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        replace: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    Custom { name: String, value: Value },
    #[serde(rename_all = "camelCase")]
    Raw {
        event: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
}

wire! {
pub struct ThreadEvent {
    pub seq: i64,
    pub thread_id: String,
    pub run_id: Option<String>,
    pub ts: String,
    pub event: AgUiEvent,
}
}

wire_enum! {
pub enum ActionKind {
    Command,
    FileChange,
    Tool,
    Computer,
    Browser,
    Network,
}
}

wire_enum! {
pub enum ApprovalState {
    Pending,
    Allowed,
    Denied,
    Expired,
}
}

wire! {
pub struct Approval {
    pub id: String,
    pub thread_id: String,
    pub run_id: String,
    pub kind: ActionKind,
    pub summary: String,
    pub detail: Value,
    pub state: ApprovalState,
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
    pub created_at: String,
}
}

wire_enum! {
pub enum PolicyEffect {
    Allow,
    Ask,
    Deny,
}
}

wire! {
pub struct PolicyRule {
    pub id: String,
    pub effect: PolicyEffect,
    pub kind: ActionKind,
    /// `*` wildcard glob matched against the action target. A leading `=` makes
    /// the rest of the pattern an exact literal, which is how `remember` stores
    /// a target that itself contains `*`.
    pub pattern: String,
    pub engine: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
}
}

wire! {
pub struct PolicyDecision {
    pub effect: PolicyEffect,
    pub rule_id: Option<String>,
    pub source: String,
    pub reason: String,
}
}

wire! {
pub struct AuditEvent {
    pub id: i64,
    pub ts: String,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub decision: Option<PolicyEffect>,
    pub source: String,
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    pub detail: Value,
}
}

wire_enum! {
pub enum EngineTier {
    Native,
    Acp,
    Agui,
    Terminal,
}
}

wire_enum! {
pub enum SkillDelivery {
    NativePlugin,
    NativeSkillRoot,
    McpSkillServer,
    PromptBootstrap,
}
}

wire! {
pub struct EngineCapabilities {
    pub streaming: bool,
    pub approvals: bool,
    pub resume: bool,
    pub mcp: bool,
    pub sandbox: bool,
    /// False means Orbyn cannot gate this engine's actions.
    pub managed: bool,
    pub skill_delivery: Vec<SkillDelivery>,
}
}

wire_enum! {
pub enum AuthState {
    LoggedIn,
    LoggedOut,
    Unknown,
    NotApplicable,
}
}

wire_enum! {
pub enum InstallerKind {
    Npm,
    Pnpm,
    Bun,
    Homebrew,
    Winget,
    SelfManaged,
    Unknown,
}
}

wire_enum! {
pub enum VersionSupport {
    Tested,
    Untested,
    BelowMinimum,
    Unknown,
}
}

wire! {
pub struct EngineStatus {
    pub id: String,
    pub name: String,
    pub tier: EngineTier,
    pub capabilities: EngineCapabilities,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub auth: AuthState,
    pub installer: InstallerKind,
    pub latest: Option<String>,
    pub support: VersionSupport,
    /// Present only when the owning installer can update this binary.
    pub update_command: Option<String>,
    pub manual_hint: Option<String>,
    pub sign_in_command: Option<String>,
    pub updating: bool,
    pub problem: Option<String>,
}
}

wire! {
pub struct SkillSummary {
    pub name: String,
    pub category: String,
    pub description: String,
    pub enabled: bool,
}
}

wire! {
pub struct SkillPackStatus {
    pub version: String,
    pub digest: String,
    pub signature_valid: bool,
    pub source: Option<String>,
    pub skills: Vec<SkillSummary>,
}
}

wire! {
pub struct SkillProfile {
    pub id: String,
    pub name: String,
    pub skills: Vec<String>,
}
}

wire! {
pub struct ComputerStatus {
    pub desktop_control: bool,
    pub desktop_path: Option<String>,
    pub desktop_version: Option<String>,
    pub browser_control: bool,
    pub browser_path: Option<String>,
    pub problem: Option<String>,
}
}

wire! {
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub patch: String,
}
}

wire! {
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_git: bool,
}
}

wire! {
pub struct FsListing {
    pub path: String,
    pub parent: Option<String>,
    /// Directories only, sorted by name.
    pub entries: Vec<FsEntry>,
}
}

wire! {
pub struct ComputerResult {
    pub ok: bool,
    pub target: String,
    /// The gateway's normalized result for the action.
    pub data: Value,
}
}

wire! {
pub struct ApiError {
    pub code: String,
    pub message: String,
    /// Structured context; `already_decided` carries the existing `Approval`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<Value>,
}
}

wire! {
pub struct ServerInfo {
    pub version: String,
    pub remote: bool,
    pub platform: String,
}
}

wire! {
pub struct CreateProject {
    pub path: String,
}
}

wire! {
pub struct CreateThread {
    pub project_id: String,
    pub engine: String,
    pub model: Option<String>,
    pub title: Option<String>,
    /// Purpose slug for an isolated worktree; `None` works in the project root.
    pub worktree: Option<String>,
    pub skill_profile: Option<String>,
}
}

wire! {
pub struct StartRun {
    pub prompt: String,
}
}

wire! {
pub struct DecideApproval {
    pub allow: bool,
    /// Also store an allow rule for this exact target.
    pub remember: bool,
}
}

wire! {
pub struct CreatePolicyRule {
    pub effect: PolicyEffect,
    pub kind: ActionKind,
    pub pattern: String,
    pub engine: Option<String>,
    pub note: Option<String>,
}
}

wire! {
pub struct CustomEngine {
    pub id: String,
    pub name: String,
    pub tier: EngineTier,
    /// ACP or terminal launch command; AG-UI endpoint URL for `agui`.
    pub target: String,
    pub args: Vec<String>,
}
}

wire! {
pub struct ComputerAction {
    pub action: String,
    pub target: String,
    pub args: Value,
}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_use_ag_ui_names() {
        let event = AgUiEvent::TextMessageContent {
            message_id: "m".into(),
            delta: "hi".into(),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"hi"})
        );
    }

    #[test]
    fn terminal_states_are_closed() {
        assert!(RunState::Interrupted.is_terminal());
        assert!(!RunState::AwaitingApproval.is_terminal());
    }
}
