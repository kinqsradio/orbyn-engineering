//! Wire types shared by the service and the UI. Timestamps are RFC 3339 UTC
//! strings and ids are opaque strings. `cargo test -p orbyn-contracts
//! export_bindings` regenerates `web/src/generated`.

use std::collections::BTreeMap;

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
    /// False for a folder that is not in Git, which works without Git's features.
    pub is_git: bool,
    pub created_at: String,
    /// Orbyn cloned or created this folder. Only such a folder can ever be deleted.
    #[serde(default)]
    pub managed: bool,
    /// A thread's dated folder under app data, hidden from project lists.
    #[serde(default)]
    pub scratch: bool,
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
    /// Choices beyond model and effort, by `ModelOption` id, such as `service_tier`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
    /// The goal the engine is working toward, as last reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<ThreadGoal>,
    /// This thread works in a scratch folder rather than a project.
    #[serde(default)]
    pub scratch: bool,
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
    /// Set when something ended a snooze before its time, until you dismiss it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub woke_at: Option<String>,
    /// The engine stopped on a usage or rate limit and nothing has run since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<ThreadLimit>,
}
}

wire! {
pub struct ThreadLimit {
    pub message: String,
    pub stopped_at: String,
    /// When the engine says the allowance returns; `None` if it did not say.
    pub resets_at: Option<String>,
    /// When a continuation is scheduled; `None` means it waits for you.
    pub resume_at: Option<String>,
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
    /// What this message sets on the thread when it starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
}
}

wire! {
pub struct EnqueueMessage {
    pub prompt: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    /// Set on the thread when this message starts, and it stays for later turns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
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
    /// A running turn keeps its own model; these apply from the next turn on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
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
/// Files a run's engine said it wrote. Nothing is inferred from the checkout, so a
/// thread sharing the folder adds nothing here. A command's own writes are not known.
pub struct RunChanges {
    pub run_id: String,
    pub paths: Vec<String>,
    /// More files were reported than are listed.
    pub truncated: bool,
    /// What was kept of them, relative to the checkout.
    #[serde(default)]
    pub files: Vec<ChangedFile>,
}
}

wire_enum! {
/// `Unknown` means an end of the change was not kept: too large, over the run's
/// budget, or written before Orbyn could look.
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Unchanged,
    Unknown,
}
}

wire! {
pub struct ChangedFile {
    pub path: String,
    pub status: ChangeStatus,
    /// Both ends were kept, so this file can be put back either way.
    pub restorable: bool,
}
}

wire! {
/// A file as a run found and left it, from what was kept then, never the folder as
/// it is now. A text is empty when absent, unknown or binary.
pub struct ChangedFileContent {
    pub path: String,
    pub status: ChangeStatus,
    pub before: Option<String>,
    pub after: Option<String>,
    pub binary: bool,
}
}

wire! {
pub struct RestoreChanges {
    /// `start` puts back what the run found; `end` what it left.
    pub point: RestorePoint,
    /// Absent means every file the run changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub paths: Option<Vec<String>>,
}
}

wire_enum! {
pub enum RestoreOutcome {
    Restored,
    /// It already matches.
    Unchanged,
    /// It holds something the run did not leave, so it was left alone.
    Conflict,
    /// That end of the change was not kept.
    NotKept,
}
}

wire! {
pub struct RestoredFile {
    pub path: String,
    pub outcome: RestoreOutcome,
}
}

wire! {
/// One request Orbyn makes without being asked.
pub struct NetworkRequest {
    pub purpose: String,
    pub host: String,
    pub cadence: String,
    /// What turns it off.
    pub control: String,
    /// The key that does, in `/api/settings` for `background_update_checks` and in
    /// preferences otherwise. Empty when nothing here controls it.
    pub setting: Option<String>,
    /// Happening now. False for one that runs only when asked.
    pub enabled: bool,
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
    /// A side chat: allowed while the parent runs, and kept out of the thread list.
    #[serde(default)]
    pub side: bool,
}
}

wire! {
pub struct SwitchEngine {
    pub engine: String,
    /// Absent uses what was last chosen on that engine.
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
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
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    /// `approved`, `changes_requested`, `review_required` or `none`.
    #[serde(default)]
    pub review_state: Option<String>,
    /// `pass`, `fail`, `pending` or `none`.
    #[serde(default)]
    pub checks_state: Option<String>,
}
}

wire! {
pub struct PullRequestDetail {
    pub pull: PullRequest,
    pub body: String,
    /// The forge's own records, which differ by forge.
    pub checks: Value,
    pub comments: Value,
    /// `mergeable`, `conflicting` or `unknown`.
    #[serde(default)]
    pub mergeable: Option<String>,
    #[serde(default)]
    pub reviewers: Vec<String>,
    #[serde(default)]
    pub head_sha: Option<String>,
    #[serde(default)]
    pub base_sha: Option<String>,
    #[serde(default)]
    pub additions: Option<u64>,
    #[serde(default)]
    pub deletions: Option<u64>,
    #[serde(default)]
    pub changed_files: Option<u64>,
    #[serde(default)]
    pub maintainer_can_modify: Option<bool>,
    #[serde(default)]
    pub auto_merge: bool,
}
}

wire! {
pub struct PullCheck {
    pub name: String,
    /// `pass`, `fail`, `pending`, `skipped` or `neutral`.
    pub state: String,
    pub url: Option<String>,
    pub workflow: Option<String>,
    pub description: Option<String>,
}
}

wire! {
pub struct PullComment {
    pub id: String,
    /// `issue` or `review` on GitHub, `note` on GitLab.
    pub kind: String,
    pub author: Option<String>,
    pub body: String,
    pub created_at: Option<String>,
    pub path: Option<String>,
    pub line: Option<u64>,
}
}

wire! {
pub struct PullThread {
    pub id: String,
    pub resolved: bool,
    pub path: Option<String>,
    pub line: Option<u64>,
    pub comments: Vec<PullComment>,
}
}

wire! {
pub struct PullConversation {
    pub comments: Vec<PullComment>,
    pub threads: Vec<PullThread>,
}
}

wire! {
pub struct PullFile {
    pub path: String,
    pub previous_path: Option<String>,
    /// `added`, `modified`, `deleted` or `renamed`.
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub patch: Option<String>,
    /// Marked viewed in Orbyn. Marks are kept by this service, per project.
    pub viewed: bool,
}
}

wire! {
pub struct PullTimelineEvent {
    pub id: String,
    /// The forge's own event name, such as `reviewed` or `labeled`.
    pub kind: String,
    pub actor: Option<String>,
    pub created_at: Option<String>,
    pub text: Option<String>,
}
}

wire! {
pub struct PullCandidate {
    pub name: String,
    pub description: Option<String>,
}
}

wire! {
pub struct AddPullComment {
    pub body: String,
    /// With `line`, a comment on that line of the new file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<u64>,
    /// A comment or thread id to reply to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reply_to: Option<String>,
}
}

wire! {
pub struct EditPullComment {
    pub kind: String,
    pub body: String,
}
}

wire! {
pub struct ReactPullComment {
    pub kind: String,
    /// GitHub's names: `+1`, `-1`, `laugh`, `hooray`, `confused`, `heart`,
    /// `rocket` or `eyes`.
    pub content: String,
}
}

wire! {
pub struct ResolvePullThread {
    pub resolved: bool,
}
}

wire! {
pub struct ReviewLineComment {
    pub path: String,
    pub line: u64,
    pub body: String,
}
}

wire! {
pub struct SubmitReview {
    /// `approve`, `request_changes` or `comment`.
    pub event: String,
    #[serde(default)]
    pub body: String,
    /// Line comments sent with the review.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<ReviewLineComment>>")]
    pub comments: Vec<ReviewLineComment>,
}
}

wire! {
pub struct SetPullPeople {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
}
}

wire! {
/// `PATCH` on a pull request. Absent fields are left alone.
#[derive(Default)]
pub struct UpdatePull {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub draft: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub maintainer_can_modify: Option<bool>,
}
}

wire! {
pub struct PullAction {
    /// `close`, `reopen`, `revert`, `update_branch`, `rebase` or `delete_branch`.
    pub action: String,
}
}

wire! {
pub struct BulkClosePulls {
    pub numbers: Vec<u64>,
}
}

wire! {
pub struct PullBulkResult {
    pub number: u64,
    pub ok: bool,
    pub message: Option<String>,
}
}

wire! {
pub struct SetFilesViewed {
    pub paths: Vec<String>,
    pub viewed: bool,
}
}

wire! {
pub struct PullListEntry {
    pub project_id: String,
    pub pull: PullRequest,
}
}

wire! {
pub struct PullList {
    pub pulls: Vec<PullListEntry>,
    /// Projects that could not be read, so a partial list is never silent.
    pub failed: Vec<PullListFailure>,
}
}

wire! {
pub struct PullListFailure {
    pub project_id: String,
    pub message: String,
}
}

wire! {
pub struct PullStack {
    /// Bottom layer first.
    pub layers: Vec<PullRequest>,
    /// Index of the pull request asked about.
    pub position: usize,
}
}

wire! {
pub struct StackAction {
    /// `merge` or `rebase`.
    pub action: String,
    /// `merge`, `squash` or `rebase`, for `merge`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub method: Option<String>,
}
}

wire! {
pub struct PullWatch {
    pub thread_id: String,
    pub number: u64,
    pub created_at: String,
}
}

wire! {
pub struct CheckoutPull {
    /// True makes a worktree under the project, false checks out in place.
    pub worktree: bool,
}
}

wire! {
pub struct PullCheckout {
    pub path: String,
    pub branch: String,
    /// Set when the local head is not the pull request's latest commit.
    pub warning: Option<String>,
}
}

wire! {
pub struct WorkOnPull {
    pub engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
}
}

wire! {
pub struct ForgeStatus {
    /// `github`, `gitlab`, `azure`, `forgejo` or `bitbucket`.
    pub id: String,
    pub name: String,
    /// The command this forge goes through; `None` when none exists.
    pub program: Option<String>,
    pub installed: bool,
    pub version: Option<String>,
    pub signed_in: bool,
    pub accounts: Vec<String>,
    pub problem: Option<String>,
}
}

wire! {
pub struct MergePull {
    /// `merge`, `squash` or `rebase`.
    pub method: String,
    /// Merge when requirements pass, rather than now.
    #[serde(default)]
    pub auto: bool,
    #[serde(default)]
    pub delete_branch: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub body: Option<String>,
    /// Removes agent credit lines from the merge commit body.
    #[serde(default)]
    pub strip_credits: bool,
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
    /// `github`, the default, or `gitlab`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub forge: Option<String>,
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
    /// the engine as typed, `agent` for a subagent reached by mentioning it, or
    /// `skill`.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
}
}

wire! {
/// A choice a model offers per turn.
pub struct ModelOption {
    /// `effort`, `service_tier`, `fast_mode` (`on` or `off`), `mode` for an ACP
    /// agent's session mode, or `config:<id>` for one of its config options.
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
    /// What a turn can carry, such as `text` and `image`. Empty is unknown.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<String>>")]
    pub input_modalities: Vec<String>,
    /// The model the engine suggests moving to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upgrade: Option<String>,
}
}

wire! {
/// A subagent the engine offers, reached by mentioning it.
pub struct EngineAgent {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
}
}

wire! {
/// What was last chosen on an engine, carried to its new threads.
#[derive(Default)]
pub struct ModelSelection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
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
    /// The list is a stand-in for an answer the engine did not give, so choices
    /// are not checked against it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(optional, as = "Option<bool>")]
    pub fallback: bool,
    /// Choices that apply to every model, such as an ACP agent's session modes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<ModelOption>>")]
    pub options: Vec<ModelOption>,
    /// Subagents the engine offers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<EngineAgent>>")]
    pub agents: Vec<EngineAgent>,
    /// Output styles the engine offers. Listed only; Orbyn does not set one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<String>>")]
    pub output_styles: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub output_style: Option<String>,
    /// What was last chosen on this engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remembered: Option<ModelSelection>,
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
    /// True clears the note that a snooze ended early.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dismiss_woke: Option<bool>,
    /// True schedules a continuation for the limit's reset; false cancels it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resume_at_reset: Option<bool>,
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
    /// Merged by key; an empty value goes back to the engine's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub options: Option<BTreeMap<String, String>>,
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

wire! {
pub struct TerminalInfo {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    /// Terminals with the same group share a split.
    pub group: String,
    /// `horizontal` or `vertical`, for a terminal split from another.
    pub direction: Option<String>,
    pub alive: bool,
    pub exit_code: Option<i32>,
    /// Clients attached right now, observers included.
    pub clients: usize,
    /// The project script this runs, if any.
    pub script: Option<String>,
    pub created_at: String,
}
}

wire! {
pub struct OpenTerminal {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// Joins this terminal's split group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub split_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub direction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rows: Option<u16>,
}
}

wire! {
pub struct RenameTerminal {
    pub title: String,
}
}

wire! {
pub struct TerminalScrollback {
    /// What the terminal printed, control sequences included.
    pub text: String,
}
}

wire! {
/// A team script from the project file.
pub struct ProjectScript {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub run_on_worktree_create: bool,
    #[serde(default)]
    pub run_on_settle: bool,
    #[serde(default)]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub auto_open_preview: bool,
}
}

wire! {
/// `orbyn.json` at the checkout's root. Orbyn only reads it.
pub struct ProjectFile {
    #[serde(default)]
    pub icon_path: Option<String>,
    /// `local` or `worktree`.
    #[serde(default)]
    pub default_thread_env_mode: Option<String>,
    /// `recursive`, `top_level` or `skip`.
    #[serde(default)]
    pub worktree_submodules: Option<String>,
    #[serde(default)]
    pub scripts: Vec<ProjectScript>,
}
}

wire! {
pub struct ProjectFileView {
    /// The file that was read, relative to the checkout.
    pub path: Option<String>,
    pub file: Option<ProjectFile>,
    /// Why a file that exists could not be used.
    pub problem: Option<String>,
}
}

wire! {
pub struct RunScript {
    pub name: String,
}
}

wire! {
pub struct PreferenceView {
    pub key: String,
    /// What applies here.
    pub value: Value,
    pub default: Value,
    /// `default`, `global` or `project`.
    pub source: String,
    /// A project may set its own value.
    pub project_scoped: bool,
}
}

wire! {
/// `null` for a key goes back to what it would inherit.
pub struct SetPreferences {
    pub values: std::collections::BTreeMap<String, Value>,
}
}

wire! {
pub struct KeybindingRule {
    pub key: String,
    pub command: String,
    #[serde(default)]
    pub when: Option<String>,
    /// In the file, turns off a default with this key and command.
    #[serde(default)]
    pub remove: bool,
}
}

wire! {
pub struct KeybindingConflict {
    pub key: String,
    pub when: Option<String>,
    pub commands: Vec<String>,
}
}

wire! {
pub struct KeybindingsView {
    /// The file, which the person may also edit by hand.
    pub path: String,
    pub rules: Vec<KeybindingRule>,
    /// What could not be read. The rest of the file still applies.
    pub issues: Vec<String>,
    pub conflicts: Vec<KeybindingConflict>,
}
}

wire! {
pub struct DatabaseStorage {
    pub bytes: u64,
    pub reclaimable_bytes: u64,
    /// Reclaimable space has reached 1 GiB.
    pub repair_suggested: bool,
}
}

wire! {
pub struct Diagnostics {
    pub version: String,
    pub pid: u32,
    pub active_runs: usize,
    pub terminals: usize,
    pub database: DatabaseStorage,
}
}

wire! {
pub struct OtlpCheck {
    pub url: String,
}
}

wire! {
pub struct OtlpResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub message: Option<String>,
}
}

wire! {
pub struct CleanupEntry {
    /// `worktree`, `artifact` or `log`.
    pub kind: String,
    pub path: String,
    pub removed: bool,
    pub reason: String,
}
}

wire! {
pub struct CleanupReport {
    pub dry_run: bool,
    pub ran_at: String,
    pub entries: Vec<CleanupEntry>,
}
}

wire! {
pub struct TaskSchedule {
    /// `interval`, `fixed_time`, `webhook` or `after_thread`.
    pub kind: String,
    #[serde(default)]
    pub every_minutes: Option<u32>,
    /// `HH:MM` for `fixed_time`.
    #[serde(default)]
    pub time: Option<String>,
    /// 0 is Sunday. Empty means every day.
    #[serde(default)]
    pub weekdays: Vec<u8>,
    #[serde(default)]
    pub utc_offset_minutes: i32,
    /// For `after_thread`: the thread whose runs set this off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after_thread: Option<String>,
    /// For `after_thread`: only when its run completed.
    #[serde(default)]
    pub only_on_success: bool,
}
}

wire! {
pub struct WebhookSignature {
    pub header: String,
    /// `hex` or `base64`.
    pub encoding: String,
    #[serde(default)]
    pub prefix: String,
}
}

wire! {
pub struct WebhookFilter {
    /// Dotted path into the body; `headers.<name>` reads a header.
    pub path: String,
    /// `equals`, `not_equals`, `starts_with`, `in` or `exists`.
    pub op: String,
    #[serde(default)]
    pub value: Option<Value>,
}
}

wire! {
pub struct WebhookDedupe {
    pub path: String,
    pub window_seconds: u64,
}
}

wire! {
pub struct ScheduledTask {
    pub id: String,
    pub project_id: String,
    /// Runs here if set; otherwise each firing opens a new thread.
    pub thread_id: Option<String>,
    pub name: String,
    /// `{{body.a.b}}` and `{{headers.x}}` read a webhook request.
    pub prompt: String,
    pub engine: String,
    pub schedule: TaskSchedule,
    pub enabled: bool,
    pub signature: Option<WebhookSignature>,
    #[serde(default)]
    pub has_secret: bool,
    #[serde(default)]
    pub filters: Vec<WebhookFilter>,
    pub dedupe: Option<WebhookDedupe>,
    /// Refuses a request older than this, read from `timestamp_path`.
    pub max_age_seconds: Option<u64>,
    pub timestamp_path: Option<String>,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    /// `never`, `started`, or why the last firing failed.
    pub last_status: String,
    pub created_at: String,
    /// The last run of `after_thread` this task has answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after_run: Option<String>,
}
}

wire! {
pub struct UpsertTask {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_id: Option<String>,
    pub name: String,
    pub prompt: String,
    pub engine: String,
    pub schedule: TaskSchedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signature: Option<WebhookSignature>,
    /// Absent keeps the stored secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub secret: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<WebhookFilter>>")]
    pub filters: Vec<WebhookFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dedupe: Option<WebhookDedupe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_age_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timestamp_path: Option<String>,
}
}

wire! {
/// A message that holds every word. `seq` is its place in the thread's log, and
/// `message_id` the message clients draw, so a client can open right at it.
pub struct MessageHit {
    pub thread_id: String,
    pub thread_title: String,
    pub project_id: String,
    pub message_id: String,
    pub seq: i64,
    pub role: String,
    pub ts: String,
    /// The text around the first word found.
    pub snippet: String,
}
}

wire! {
pub struct ThreadMessage {
    pub message_id: String,
    pub seq: i64,
    pub role: String,
    pub ts: String,
    pub text: String,
}
}

wire! {
pub struct MessageSearch {
    pub hits: Vec<MessageHit>,
    /// The words to highlight, lower-cased.
    pub words: Vec<String>,
    /// No word was long enough to search for, so nothing was searched.
    pub too_short: bool,
    /// More matched, or too many messages to read them all. Narrow the search.
    pub truncated: bool,
}
}

wire! {
/// `run_id` is what was stopped, and empty when nothing was running.
pub struct ForcedStop {
    pub run_id: Option<String>,
    pub state: Option<RunState>,
}
}

wire! {
pub struct RenameProject {
    pub name: String,
}
}

wire! {
pub struct TaskEnabled {
    pub enabled: bool,
}
}

wire! {
/// The token appears here once; only its digest is kept.
pub struct WebhookEndpoint {
    pub path: String,
    pub token: String,
}
}

wire! {
pub struct WebhookDelivery {
    pub id: String,
    pub task_id: String,
    /// `accepted`, `bad_signature`, `filtered`, `duplicate`, `stale`, `disabled`
    /// or `failed`.
    pub status: String,
    pub received_at: String,
    /// With credentials removed.
    pub headers: Value,
    pub body: String,
    pub prompt: Option<String>,
    pub thread_id: Option<String>,
}
}

wire! {
pub struct DelegateTask {
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// Absent uses the parent's engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
}
}

wire! {
pub struct BatchThread {
    pub thread: CreateThread,
    pub prompt: String,
}
}

wire! {
pub struct BatchThreads {
    pub threads: Vec<BatchThread>,
}
}

wire! {
pub struct BatchThreadResult {
    pub thread: Option<Thread>,
    pub error: Option<String>,
}
}

wire! {
pub struct LocalServer {
    pub port: u16,
    pub pid: u32,
    pub process: String,
    /// False where Orbyn cannot tell which folder a process runs in, as on Windows.
    pub in_checkout: bool,
}
}

wire! {
pub struct PreviewTab {
    pub id: String,
    pub thread_id: String,
    pub url: String,
    /// `human` while a person holds the page, `none` otherwise.
    pub control: String,
    pub recording: bool,
    pub viewers: usize,
    pub width: u32,
    pub height: u32,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}
}

wire! {
pub struct OpenPreview {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<u32>,
}
}

wire! {
pub struct NavigatePreview {
    pub url: String,
}
}

wire! {
pub struct StepPreview {
    /// True goes back; false goes forward.
    pub back: bool,
}
}

wire! {
pub struct ResizePreview {
    pub width: u32,
    pub height: u32,
}
}

wire! {
pub struct PreviewControl {
    /// True takes the page; false hands it back.
    pub human: bool,
}
}

wire! {
pub struct PreviewInput {
    /// `click`, `move`, `scroll`, `key` or `text`.
    pub kind: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub delta_y: f64,
    /// A key name for `key`, or the text for `text`.
    #[serde(default)]
    pub text: String,
}
}

wire! {
pub struct PreviewRecording {
    pub path: String,
    pub frames: u64,
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
    /// Credential variables this engine would inherit, by name only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, as = "Option<Vec<String>>")]
    pub inherited_credentials: Vec<String>,
    /// The origin of an inherited endpoint override, with no path or user info.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub endpoint_origin: Option<String>,
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
    /// Absolute folder to clone into; absent means `<workspace>/repo/<slug>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
}
}

wire! {
pub struct NewProject {
    pub name: String,
    /// Adds a README and makes the first commit.
    #[serde(default)]
    pub readme: bool,
    /// Absolute folder to create; absent means `<workspace>/repo/<slug>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
}
}

wire_enum! {
pub enum CloneState {
    Running,
    Done,
    Failed,
    Cancelled,
}
}

wire! {
/// A clone running in the background. Jobs live until the service stops.
pub struct CloneJob {
    pub id: String,
    pub url: String,
    pub name: Option<String>,
    pub path: Option<String>,
    pub state: CloneState,
    pub project: Option<Project>,
    pub error: Option<String>,
    /// True when an SSH URL was refused and HTTPS worked instead.
    pub used_https: bool,
    pub started_at: String,
}
}

wire! {
/// Registers an existing folder where it is. Nothing is cloned, moved or written.
pub struct AddProject {
    pub path: String,
}
}

wire! {
/// Moves a thread with no runs yet. No `project_id` gives it a scratch folder.
pub struct MoveThread {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_id: Option<String>,
}
}

wire! {
/// Turns a scratch folder into a project, in place, with its threads.
pub struct AdoptScratch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
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
    /// Absent starts the thread in its own scratch folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_id: Option<String>,
    pub engine: String,
    pub model: Option<String>,
    pub title: Option<String>,
    /// Purpose slug for an isolated worktree; `None` works in the project root.
    pub worktree: Option<String>,
    pub skill_profile: Option<String>,
    /// Where a new worktree starts; absent follows the settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_branch: Option<String>,
    /// Absent effort and options follow what was last chosen for this model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
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
    /// Merged into the thread's options for this turn and the ones after it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(optional, as = "Option<BTreeMap<String, String>>")]
    pub options: BTreeMap<String, String>,
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
/// An agent the ACP registry lists. Nothing here is installed by being listed.
pub struct AcpRegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// What this machine can install it through, best first: `binary`, `npx`, `uvx`.
    pub installable: Vec<String>,
    /// The engine it became, once installed.
    pub engine: Option<String>,
}
}

wire! {
pub struct InstallAcpAgent {
    /// `binary`, `npx` or `uvx`. Absent takes the best this machine can use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub distribution: Option<String>,
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
