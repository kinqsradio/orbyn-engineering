/**
 * The UI's view of the wire. Everything comes from `src/generated`. The few
 * adjustments here describe what JSON actually delivers.
 */
import type { Approval as ApprovalWire } from "../generated/Approval";
import type { EngineLimits as EngineLimitsWire } from "../generated/EngineLimits";
import type { EngineUsage as EngineUsageWire } from "../generated/EngineUsage";
import type { LimitsOverview as LimitsOverviewWire } from "../generated/LimitsOverview";
import type { ModelUsage as ModelUsageWire } from "../generated/ModelUsage";
import type { PullCheck as PullCheckWire } from "../generated/PullCheck";
import type { PullConversation as PullConversationWire } from "../generated/PullConversation";
import type { PullFile as PullFileWire } from "../generated/PullFile";
import type { PullList as PullListWire } from "../generated/PullList";
import type { PullListEntry as PullListEntryWire } from "../generated/PullListEntry";
import type { PullBulkResult as PullBulkResultWire } from "../generated/PullBulkResult";
import type { PullComment as PullCommentWire } from "../generated/PullComment";
import type { PullRequest as PullRequestWire } from "../generated/PullRequest";
import type { PullStack as PullStackWire } from "../generated/PullStack";
import type { PullThread as PullThreadWire } from "../generated/PullThread";
import type { PullWatch as PullWatchWire } from "../generated/PullWatch";
import type { ReviewLineComment as ReviewLineCommentWire } from "../generated/ReviewLineComment";
import type { PullRequestDetail as PullRequestDetailWire } from "../generated/PullRequestDetail";
import type { PullTimelineEvent as PullTimelineEventWire } from "../generated/PullTimelineEvent";
import type { FileContent as FileContentWire } from "../generated/FileContent";
import type { FileEntry as FileEntryWire } from "../generated/FileEntry";
import type { Diagnostics as DiagnosticsWire } from "../generated/Diagnostics";
import type { ScheduledTask as ScheduledTaskWire } from "../generated/ScheduledTask";
import type { ThreadEvent } from "../generated/ThreadEvent";
import type { UsageReport as UsageReportWire } from "../generated/UsageReport";

export type { AcpRegistryEntry } from "../generated/AcpRegistryEntry";
export type { BranchInfo } from "../generated/BranchInfo";
export type { GitAction } from "../generated/GitAction";
export type { GitActionResult } from "../generated/GitActionResult";
export type { GitPhase } from "../generated/GitPhase";
export type { PublishProject } from "../generated/PublishProject";
export type { RestorePoint } from "../generated/RestorePoint";
export type { CleanupReport } from "../generated/CleanupReport";
export type { OtlpResult } from "../generated/OtlpResult";
export type { ActionKind } from "../generated/ActionKind";
export type { AgUiEvent } from "../generated/AgUiEvent";
export type { ApiError } from "../generated/ApiError";
export type { ApplyAllResult } from "../generated/ApplyAllResult";
export type { Approval } from "../generated/Approval";
export type { ApprovalState } from "../generated/ApprovalState";
export type { Attachment } from "../generated/Attachment";
export type { AuthState } from "../generated/AuthState";
export type { CreateThread } from "../generated/CreateThread";
export type { CustomEngine } from "../generated/CustomEngine";
export type { EngineModels } from "../generated/EngineModels";
export type { EngineStatus } from "../generated/EngineStatus";
export type { EngineTier } from "../generated/EngineTier";
export type { FileDiff } from "../generated/FileDiff";
export type { FsEntry } from "../generated/FsEntry";
export type { FsListing } from "../generated/FsListing";
export type { CloneJob } from "../generated/CloneJob";
export type { IncomingCommit } from "../generated/IncomingCommit";
export type { LibraryStatus } from "../generated/LibraryStatus";
export type { LibraryUpdateResult } from "../generated/LibraryUpdateResult";
export type { Mentions } from "../generated/Mentions";
export type { ModelInfo } from "../generated/ModelInfo";
export type { ModelOption } from "../generated/ModelOption";
export type { PermissionMode } from "../generated/PermissionMode";
export type { Project } from "../generated/Project";
export type { ProjectRemoval } from "../generated/ProjectRemoval";
export type { QueuedMessage } from "../generated/QueuedMessage";
export type { Run } from "../generated/Run";
export type { RunState } from "../generated/RunState";
export type { ServerInfo } from "../generated/ServerInfo";
export type { BrowserProfile } from "../generated/BrowserProfile";
export type { PickedElement } from "../generated/PickedElement";
export type { ShellEvent } from "../generated/ShellEvent";
export type { ShellStatus } from "../generated/ShellStatus";
export type { ServerSettings } from "../generated/ServerSettings";
export type { SlashCommand } from "../generated/SlashCommand";
export type { TargetStatus } from "../generated/TargetStatus";
export type { Thread } from "../generated/Thread";
export type { UpdateStatus } from "../generated/UpdateStatus";
export type { UpdateThread } from "../generated/UpdateThread";
export type { VersionSupport } from "../generated/VersionSupport";
export type { WorkspaceSetup } from "../generated/WorkspaceSetup";
export type { WorkspaceStatus } from "../generated/WorkspaceStatus";

/** ts-rs maps i64 to bigint, but JSON.parse produces a number. */
type Int64AsNumber<T, K extends keyof T> = Omit<T, K> & { [P in K]: number };

export type WireThreadEvent = Int64AsNumber<ThreadEvent, "seq">;

/** The generated JSON type, reached without naming its path under `crates`. */
export type JsonValue = ApprovalWire["detail"];

/** Deeply, every i64 as JSON.parse delivers it. */
export type Wired<T> = T extends bigint
  ? number
  : T extends (infer U)[]
    ? Wired<U>[]
    : T extends object
      ? { [K in keyof T]: Wired<T[K]> }
      : T;

export type UsageReport = Wired<UsageReportWire>;
export type EngineUsage = Wired<EngineUsageWire>;
export type ModelUsage = Wired<ModelUsageWire>;
export type LimitsOverview = Wired<LimitsOverviewWire>;
export type EngineLimits = Wired<EngineLimitsWire>;
export type PullRequest = Wired<PullRequestWire>;
export type PullRequestDetail = Wired<PullRequestDetailWire>;
export type PullList = Wired<PullListWire>;
export type PullListEntry = Wired<PullListEntryWire>;
export type PullCheck = Wired<PullCheckWire>;
export type PullConversation = Wired<PullConversationWire>;
export type PullFile = Wired<PullFileWire>;
export type PullComment = Wired<PullCommentWire>;
export type PullThread = Wired<PullThreadWire>;
export type PullStack = Wired<PullStackWire>;
export type PullWatch = Wired<PullWatchWire>;
export type PullBulkResult = Wired<PullBulkResultWire>;
export type ReviewLineComment = Wired<ReviewLineCommentWire>;
export type { MergePull } from "../generated/MergePull";
export type { PullCandidate } from "../generated/PullCandidate";
export type { PullCheckout } from "../generated/PullCheckout";
export type { UpdatePull } from "../generated/UpdatePull";
export type PullTimelineEvent = Wired<PullTimelineEventWire>;
export type { ForgeStatus } from "../generated/ForgeStatus";
export type { EditorInfo } from "../generated/EditorInfo";
export type FileEntry = Wired<FileEntryWire>;
export type FileContent = Wired<FileContentWire>;
export type { Checkpoint } from "../generated/Checkpoint";
export type { ProjectFileView } from "../generated/ProjectFileView";
export type { Question } from "../generated/Question";
export type { QuestionRequest } from "../generated/QuestionRequest";
export type { SearchHit } from "../generated/SearchHit";
export type { MessageSearch } from "../generated/MessageSearch";
export type { RestoredFile } from "../generated/RestoredFile";
export type { RestoreOutcome } from "../generated/RestoreOutcome";
export type { RunChanges } from "../generated/RunChanges";
export type { TerminalInfo } from "../generated/TerminalInfo";
export type Diagnostics = Wired<DiagnosticsWire>;
export type ScheduledTask = Wired<ScheduledTaskWire>;
export type { WebhookDelivery } from "../generated/WebhookDelivery";
export type { WebhookEndpoint } from "../generated/WebhookEndpoint";
export type { WebhookFilter } from "../generated/WebhookFilter";
export type { KeybindingsView } from "../generated/KeybindingsView";
export type { CommitInfo } from "../generated/CommitInfo";
export type { PreviewTab } from "../generated/PreviewTab";
export type { LocalServer } from "../generated/LocalServer";
export type { KeybindingRule } from "../generated/KeybindingRule";
export type { PreferenceView } from "../generated/PreferenceView";
