/**
 * The UI's view of the wire. Everything comes from `src/generated`. The few
 * adjustments here describe what JSON actually delivers.
 */
import type { Approval as ApprovalWire } from "../generated/Approval";
import type { EngineLimits as EngineLimitsWire } from "../generated/EngineLimits";
import type { EngineUsage as EngineUsageWire } from "../generated/EngineUsage";
import type { LimitsOverview as LimitsOverviewWire } from "../generated/LimitsOverview";
import type { ModelUsage as ModelUsageWire } from "../generated/ModelUsage";
import type { ThreadEvent } from "../generated/ThreadEvent";
import type { UsageReport as UsageReportWire } from "../generated/UsageReport";

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
export type { PermissionMode } from "../generated/PermissionMode";
export type { Project } from "../generated/Project";
export type { ProjectRemoval } from "../generated/ProjectRemoval";
export type { QueuedMessage } from "../generated/QueuedMessage";
export type { Run } from "../generated/Run";
export type { RunState } from "../generated/RunState";
export type { ServerInfo } from "../generated/ServerInfo";
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
