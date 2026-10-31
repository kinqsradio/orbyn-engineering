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
    /// Reasoning effort for this thread's turns; `None` is the engine's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    /// The goal the engine is working toward, as last reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<ThreadGoal>,
}
}

wire! {
pub struct ThreadGoal {
    pub objective: String,
    /// `active`, `paused`, `blocked`, `usage_limited`, `budget_limited` or `complete`.
    pub status: String,
    pub tokens_used: Option<u64>,
    pub token_budget: Option<u64>,
    pub seconds_used: Option<u64>,
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
    pub permission_mode: PermissionMode,
    pub plan_mode: bool,
}
}

wire_enum! {
pub enum PermissionMode {
    /// Asks before commands and edits.
    Supervised,
    /// Accepts edits inside the checkout.
    AutoEdits,
    /// Also accepts commands.
    Auto,
    /// Accepts everything policy does not refuse. Writes stay in the checkout.
    FullAccess,
}
}

wire! {
pub struct QueuedMessage {
    pub id: String,
    pub thread_id: String,
    pub prompt: String,
    pub attachment_ids: Vec<String>,
    /// Held messages wait for a resume after a stop, failure or restart.
    pub held: bool,
    pub created_at: String,
}
}

wire! {
pub struct EnqueueMessage {
    pub prompt: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}
}

wire! {
pub struct EditQueuedMessage {
    pub prompt: String,
}
}

wire! {
pub struct SteerRun {
    pub prompt: String,
}
}

wire! {
pub struct Attachment {
    pub id: String,
    pub thread_id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub created_at: String,
}
}

wire! {
/// One engine item as the engine reported it, for the item inspector.
pub struct ThreadItemRecord {
    pub item_id: String,
    pub run_id: Option<String>,
    pub kind: String,
    pub raw: Value,
    pub exit_code: Option<i64>,
    pub updated_at: String,
}
}

wire! {
pub struct ThreadUsage {
    pub total_tokens: Option<u64>,
    pub context_window: Option<u64>,
    /// The engine's own report, which varies by engine.
    pub raw: Value,
}
}

wire! {
pub struct FileEntry {
    pub name: String,
    /// Relative to the checkout.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub ignored: bool,
}
}

wire! {
pub struct FileContent {
    pub path: String,
    /// Empty when `binary` or `truncated`.
    pub content: String,
    /// Digest of the file's bytes; send it back to write safely.
    pub revision: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
}
}

wire! {
pub struct WriteFile {
    pub path: String,
    pub content: String,
    /// The revision this edit started from; `None` means the file must not exist.
    pub base_revision: Option<String>,
}
}

wire! {
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}
}

wire! {
pub struct EditorInfo {
    pub id: String,
    pub name: String,
    /// `path`, `goto` or `line_column`; `path` editors take `file:line:col`.
    #[serde(default)]
    pub launch_style: String,
    /// The system file manager, which reveals a file and has no line target.
    #[serde(default)]
    pub file_manager: bool,
}
}

wire! {
pub struct OpenInEditor {
    pub path: String,
    pub editor: String,
    /// One-based position to open at. A column needs a line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub column: Option<u32>,
}
}

wire! {
/// The workspace before and after one run, kept in hidden refs.
pub struct Checkpoint {
    pub run_id: String,
    pub start: String,
    /// Absent until the run ends.
    pub end: Option<String>,
    pub created_at: String,
}
}

wire! {
pub struct CommitInfo {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}
}

wire_enum! {
pub enum RestorePoint {
    /// As the run found it.
    Start,
    /// As the run left it.
    End,
}
}

wire! {
pub struct RestoreWorkspace {
    pub run_id: String,
    pub point: RestorePoint,
}
}

wire! {
pub struct RewindThread {
    /// The conversation continues from just before this run.
    pub run_id: String,
    pub restore_files: bool,
}
}

wire! {
pub struct ForkThread {
    /// Fork after this run; absent forks the whole conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
}
}

wire! {
pub struct SwitchEngine {
    pub engine: String,
    pub model: Option<String>,
}
}

wire! {
pub struct PullRequestDraft {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base: Option<String>,
}
}

wire! {
/// Any combination of commit, push and open a pull request, in that order.
pub struct GitAction {
    /// Commits every change with this message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub commit_message: Option<String>,
    #[serde(default)]
    pub push: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pull_request: Option<PullRequestDraft>,
}
}

wire! {
pub struct GitPhase {
    /// `commit`, `push` or `pull_request`.
    pub name: String,
    pub ok: bool,
    pub message: Option<String>,
    pub url: Option<String>,
}
}

wire! {
pub struct GitActionResult {
    /// Phases that ran. A failed phase is the last one.
    pub phases: Vec<GitPhase>,
}
}

wire! {
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}
}

wire! {
pub struct CreateBranch {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start: Option<String>,
}
}

wire! {
pub struct SwitchBranch {
    pub name: String,
}
}

wire! {
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `open`, `merged` or `closed`.
    pub state: String,
    pub head: String,
    pub base: String,
    pub author: Option<String>,
}
}

wire! {
pub struct PullRequestDetail {
    pub pull: PullRequest,
    pub body: String,
    /// The forge's own records, which differ by forge.
    pub checks: Value,
    pub comments: Value,
}
}

wire! {
pub struct SubmitReview {
    /// `approve`, `request_changes` or `comment`.
    pub event: String,
    #[serde(default)]
    pub body: String,
}
}

wire! {
pub struct MergePull {
    /// `merge`, `squash` or `rebase`.
    pub method: String,
}
}

wire! {
pub struct LinkPull {
    pub number: u64,
}
}

wire! {
pub struct PublishProject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub private: bool,
}
}

wire! {
pub struct Mentions {
    pub skills: Vec<String>,
    /// Paths relative to the checkout, best match first.
    pub files: Vec<String>,
    /// Other threads in this project.
    #[serde(default)]
    pub threads: Vec<ThreadMention>,
}
}

wire! {
pub struct ThreadMention {
    pub id: String,
    pub title: String,
}
}

wire! {
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    /// `orbyn` commands the service or client handles, `engine` commands sent to
    /// the engine as typed, or `skill`.
    #[serde(default)]
    pub source: String,
}
}

wire! {
/// One value of a model option, such as `high` for effort.
pub struct ModelOptionValue {
    pub id: String,
    pub label: String,
    pub default: bool,
}
}

wire! {
/// A choice a model offers per turn.
pub struct ModelOption {
    /// `effort` is the only id today.
    pub id: String,
    pub label: String,
    pub values: Vec<ModelOptionValue>,
}
}

wire! {
pub struct ModelInfo {
    /// What `--model`, `model` and `session/set_model` take.
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub is_default: bool,
    /// Added in settings rather than reported by the engine.
    pub custom: bool,
    pub options: Vec<ModelOption>,
}
}

wire! {
pub struct EngineModels {
    pub engine: String,
    /// `engine`, `documented` (a fixed list from the vendor's docs) or `none`.
    pub source: String,
    pub models: Vec<ModelInfo>,
    /// Why the engine could not be asked. Custom models still appear.
    pub error: Option<String>,
    pub checked_at: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan_mode: Option<bool>,
    /// An empty string goes back to the engine's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// An empty string goes back to the engine's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
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
    /// `false` turns background update checks off. Absent means on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_update_checks: Option<bool>,
    /// Per-model rates. A model with no rate has an unknown cost.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<ModelPrice>>")]
    pub model_prices: Vec<ModelPrice>,
    /// Counts one model as another when pricing and grouping.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<ModelAlias>>")]
    pub model_aliases: Vec<ModelAlias>,
}
}

wire! {
/// US dollars per million tokens.
pub struct ModelPrice {
    pub model: String,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}
}

wire! {
pub struct ModelAlias {
    pub model: String,
    pub counts_as: String,
}
}

wire! {
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// `None` when this model has no configured price.
    pub estimated_cost: Option<f64>,
}
}

wire! {
pub struct DailyUsage {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub tokens: u64,
}
}

wire! {
pub struct EngineUsage {
    pub engine: String,
    /// `scanned`, or `no_history` when this machine has none.
    pub status: String,
    pub files_scanned: u32,
    pub files_skipped: u32,
    pub models: Vec<ModelUsage>,
    pub days: Vec<DailyUsage>,
}
}

wire! {
pub struct UsageReport {
    /// Stable for this machine.
    pub host_id: String,
    pub scanned_at: String,
    pub engines: Vec<EngineUsage>,
}
}

wire! {
pub struct EngineLimits {
    pub engine: String,
    pub checked_at: String,
    /// The engine's own report, which it gives without Orbyn reading a credential.
    pub limits: Value,
    /// The same report in one shape. Empty when the shape is unknown.
    #[serde(default)]
    pub windows: Vec<LimitWindow>,
    /// The subscription plan, when the engine names it.
    #[serde(default)]
    pub plan: Option<String>,
}
}

wire! {
pub struct LimitWindow {
    /// `primary` or `secondary`.
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<String>,
}
}

wire! {
/// One number per window: the most used engine, since that one stops first.
pub struct PooledWindow {
    pub label: String,
    pub window_minutes: Option<u64>,
    pub used_percent: f64,
    /// The soonest reset among the engines counted.
    pub resets_at: Option<String>,
    pub engines: Vec<String>,
}
}

wire! {
pub struct LimitsOverview {
    pub pooled: Vec<PooledWindow>,
    pub engines: Vec<EngineLimits>,
    /// Engines with no report, with why.
    pub unavailable: Vec<LimitsUnavailable>,
}
}

wire! {
pub struct LimitsUnavailable {
    pub engine: String,
    pub reason: String,
}
}

wire! {
pub struct LibraryUpdateStatus {
    pub current: Option<String>,
    pub latest: Option<String>,
    pub behind: u32,
    pub ahead: u32,
    pub dirty: bool,
    pub incoming: Vec<IncomingCommit>,
    pub can_apply: bool,
    pub blocked_reason: Option<String>,
}
}

wire_enum! {
pub enum AppMode {
    Desktop,
    Server,
}
}

wire! {
pub struct AppUpdateStatus {
    pub current: String,
    pub latest: Option<String>,
    pub notes: Option<String>,
    pub mode: AppMode,
    pub can_apply: bool,
    pub blocked_reason: Option<String>,
    pub unconfigured: bool,
    /// Bytes fetched so far while the shell downloads, when it reports them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub downloaded: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total: Option<u64>,
}
}

wire! {
pub struct EngineUpdateStatus {
    pub id: String,
    pub current: Option<String>,
    pub latest: Option<String>,
    pub support: VersionSupport,
    pub can_apply: bool,
    pub blocked_reason: Option<String>,
}
}

wire! {
pub struct UpdateStatus {
    pub library: LibraryUpdateStatus,
    pub app: AppUpdateStatus,
    pub engines: Vec<EngineUpdateStatus>,
    /// When the last check fully succeeded.
    pub checked_at: Option<String>,
    /// Why the last check fell short. Earlier results stay in place.
    pub error: Option<String>,
}
}

wire! {
pub struct UpdateStep {
    /// `engine:<id>`, `library` or `app`.
    pub target: String,
    pub ok: bool,
    pub message: Option<String>,
}
}

wire! {
pub struct ApplyAllResult {
    /// Steps in the order they ran. A failed step is the last one.
    pub steps: Vec<UpdateStep>,
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

wire! {
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}
}

wire! {
pub struct Question {
    /// What an answer is keyed by.
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    /// A typed answer is allowed alongside the options.
    pub allow_other: bool,
    /// Mask the input. Orbyn passes the answer on and never stores it.
    pub secret: bool,
}
}

wire_enum! {
pub enum QuestionState {
    Pending,
    Answered,
    Dismissed,
    Expired,
}
}

wire! {
/// An engine's question, which holds its run until answered or dismissed.
pub struct QuestionRequest {
    pub id: String,
    pub thread_id: String,
    pub run_id: String,
    pub questions: Vec<Question>,
    pub state: QuestionState,
    /// Keyed by question id. Secret answers read `[hidden]`.
    pub answers: Option<std::collections::BTreeMap<String, Vec<String>>>,
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
    pub created_at: String,
}
}

wire! {
pub struct AnswerQuestion {
    pub answers: std::collections::BTreeMap<String, Vec<String>>,
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
    /// The engine can pause and resume a goal, not only set and clear it.
    #[serde(default)]
    pub goal_control: bool,
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
pub struct IncomingCommit {
    pub sha: String,
    pub subject: String,
}
}

wire! {
pub struct LibraryStatus {
    pub path: String,
    /// True when the user chose an existing checkout, which is never moved.
    pub adopted: bool,
    pub revision: String,
    pub branch: Option<String>,
    pub dirty: bool,
    pub dirty_files: Vec<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The revision a rollback would return to.
    pub previous_revision: Option<String>,
    /// False when `.claude/skills` or `.agents/skills` did not materialize as
    /// links, which sends this session to the MCP skill route.
    pub native_skills: bool,
    pub problem: Option<String>,
}
}

wire! {
pub struct TargetWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub revision: String,
    pub dirty: bool,
}
}

wire! {
pub struct TargetStatus {
    pub project_id: Option<String>,
    pub path: String,
    pub git_root: Option<String>,
    pub revision: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub worktrees: Vec<TargetWorktree>,
    pub instructions: Vec<String>,
    /// Target skills sharing a library skill's name. Both stay; neither is renamed.
    pub same_name_skills: Vec<String>,
    pub problem: Option<String>,
}
}

wire! {
pub struct WorkspaceStatus {
    /// False until setup finishes; engines and projects wait for it.
    pub configured: bool,
    pub default_url: String,
    pub library: Option<LibraryStatus>,
    pub targets: Vec<TargetStatus>,
}
}

wire! {
/// Exactly one of `url` and `adopt_path`, or neither for the default library.
pub struct WorkspaceSetup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub adopt_path: Option<String>,
}
}

wire! {
pub struct LibraryUpdateRequest {
    /// False only fetches and reports incoming commits.
    pub apply: bool,
}
}

wire! {
pub struct LibraryUpdateResult {
    pub applied: bool,
    pub previous_revision: Option<String>,
    pub revision: String,
    pub incoming: Vec<IncomingCommit>,
}
}

wire! {
pub struct CloneProject {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
}
}

wire! {
pub struct NewProject {
    pub name: String,
}
}

wire! {
pub struct ImportProject {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
}
}

wire! {
pub struct ImportReport {
    pub project: Project,
    /// Changes in the source that the import did not carry.
    pub dirty_files: Vec<String>,
    pub unpushed_branches: Vec<String>,
}
}

wire! {
pub struct ProjectRemoval {
    pub files_removed: bool,
    /// Set when the folder stays on disk because it still holds work.
    pub kept_path: Option<String>,
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
    /// Short library revision, with `-dirty` when it has local edits.
    pub version: String,
    /// Full library revision.
    pub digest: String,
    /// True when the workspace library is valid.
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<String>>")]
    pub attachment_ids: Vec<String>,
    /// Sets the thread's mode for this turn and the ones after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission_mode: Option<PermissionMode>,
    /// Sets the thread's model for this turn and the ones after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// Sets the thread's effort for this turn and the ones after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
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
