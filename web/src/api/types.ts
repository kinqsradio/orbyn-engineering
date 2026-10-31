/**
 * The UI's view of the wire. Everything comes from `src/generated`. The few
 * adjustments here describe what JSON actually delivers.
 */
import type { Approval as ApprovalWire } from "../generated/Approval";
import type { AuditEvent } from "../generated/AuditEvent";
import type { ThreadEvent } from "../generated/ThreadEvent";

export type { ActionKind } from "../generated/ActionKind";
export type { AgUiEvent } from "../generated/AgUiEvent";
export type { ApiError } from "../generated/ApiError";
export type { Approval } from "../generated/Approval";
export type { ApprovalState } from "../generated/ApprovalState";
export type { AuthState } from "../generated/AuthState";
export type { ComputerStatus } from "../generated/ComputerStatus";
export type { CreatePolicyRule } from "../generated/CreatePolicyRule";
export type { CreateThread } from "../generated/CreateThread";
export type { CustomEngine } from "../generated/CustomEngine";
export type { EngineStatus } from "../generated/EngineStatus";
export type { EngineTier } from "../generated/EngineTier";
export type { FileDiff } from "../generated/FileDiff";
export type { PolicyEffect } from "../generated/PolicyEffect";
export type { PolicyRule } from "../generated/PolicyRule";
export type { Project } from "../generated/Project";
export type { Run } from "../generated/Run";
export type { RunState } from "../generated/RunState";
export type { ServerInfo } from "../generated/ServerInfo";
export type { SkillPackStatus } from "../generated/SkillPackStatus";
export type { SkillProfile } from "../generated/SkillProfile";
export type { SkillSummary } from "../generated/SkillSummary";
export type { Thread } from "../generated/Thread";
export type { VersionSupport } from "../generated/VersionSupport";

/** ts-rs maps i64 to bigint, but JSON.parse produces a number. */
type Int64AsNumber<T, K extends keyof T> = Omit<T, K> & { [P in K]: number };

export type WireThreadEvent = Int64AsNumber<ThreadEvent, "seq">;
export type WireAuditEvent = Int64AsNumber<AuditEvent, "id">;

/** The generated JSON type, reached without naming its path under `crates`. */
export type JsonValue = ApprovalWire["detail"];

/**
 * `GET /api/fs/browse` has no generated type yet. Parsed at the boundary in
 * client.ts, so a differing server shape reads as an error rather than a crash.
 */
export interface FsEntry {
  name: string;
  path: string;
  is_git: boolean;
}
export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}
