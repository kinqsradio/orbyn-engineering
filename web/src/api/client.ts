import { readToken } from "./token";
import type { SteerResult } from "../generated/SteerResult";
import type {
  BranchInfo,
  GitAction,
  GitActionResult,
  CommitInfo,
  MessageSearch,
  RestoredFile,
  RunChanges,
  SearchHit,
  EngineLimits,
  KeybindingsView,
  ApplyAllResult,
  Approval,
  Attachment,
  Checkpoint,
  CloneJob,
  CreateThread,
  CustomEngine,
  EditorInfo,
  EngineModels,
  EngineStatus,
  FileDiff,
  FsListing,
  JsonValue,
  LibraryUpdateResult,
  LimitsOverview,
  Mentions,
  PermissionMode,
  Project,
  ProjectRemoval,
  QueuedMessage,
  Run,
  ServerInfo,
  PublishProject,
  RestorePoint,
  ServerSettings,
  SlashCommand,
  Thread,
  UpdateStatus,
  UpdateThread,
  UsageReport,
  WorkspaceSetup,
  WorkspaceStatus,
} from "./types";

/** A failed request. `code` is the server's stable code, or a local one below. */
export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;
  /** `already_decided` carries the existing `Approval` here. */
  readonly detail: unknown;

  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export const NETWORK_ERROR = "network_error";

/** Used by the shell to swap to sign-in when the session stops being accepted. */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

const SLOW_REQUEST_MS = 10_000;

let onSlowRequest: () => void = () => undefined;
export function setSlowRequestHandler(handler: () => void): void {
  onSlowRequest = handler;
}

export function authHeaders(): Record<string, string> {
  const token = readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function failureFrom(response: Response): Promise<ApiFailure> {
  let code = `http_${response.status}`;
  let message = `The server answered ${response.status}.`;
  let detail: unknown;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.code === "string") {
      code = body.code;
      if (typeof body.message === "string") message = body.message;
      detail = body.detail;
    }
  } catch {
    // Not an ApiError body; the status is all there is.
  }
  return new ApiFailure(code, message, response.status, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  const slow = setTimeout(() => onSlowRequest(), SLOW_REQUEST_MS);
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      signal,
      headers: {
        ...authHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiFailure(NETWORK_ERROR, "Can't reach the Orbyn service.", 0);
  } finally {
    clearTimeout(slow);
  }
  if (!response.ok) {
    const failure = await failureFrom(response);
    if (response.status === 401) onUnauthorized();
    throw failure;
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const q = encodeURIComponent;

export const api = {
  queue: (threadId: string, signal?: AbortSignal) =>
    request<QueuedMessage[]>("GET", `/api/threads/${q(threadId)}/queue`, undefined, signal),
  enqueue: (threadId: string, prompt: string, attachmentIds: string[]) =>
    request<QueuedMessage>("POST", `/api/threads/${q(threadId)}/queue`, {
      prompt,
      attachment_ids: attachmentIds,
    }),
  resumeQueue: (threadId: string) => request<void>("POST", `/api/threads/${q(threadId)}/queue/resume`),
  removeQueued: (id: string) => request<void>("DELETE", `/api/queue/${q(id)}`),
  sendQueuedNow: (id: string) => request<void>("POST", `/api/queue/${q(id)}/send-now`),
  steer: (threadId: string, prompt: string) =>
    request<SteerResult>("POST", `/api/threads/${q(threadId)}/steer`, { prompt }),
  restartSession: (threadId: string) => request<void>("POST", `/api/threads/${q(threadId)}/restart-session`),
  patchThread: (id: string, body: UpdateThread) =>
    request<Thread>("PATCH", `/api/threads/${q(id)}`, body),
  threadLimits: (threadId: string, signal?: AbortSignal) =>
    request<EngineLimits>("GET", `/api/threads/${q(threadId)}/limits`, undefined, signal),
  searchFiles: (threadId: string, query: string, content: boolean, signal?: AbortSignal) =>
    request<SearchHit[]>("GET", `/api/threads/${q(threadId)}/files/search?q=${q(query)}&content=${content}`, undefined, signal),
  commits: (threadId: string, signal?: AbortSignal) =>
    request<CommitInfo[]>("GET", `/api/threads/${q(threadId)}/commits`, undefined, signal),
  keybindings: (signal?: AbortSignal) =>
    request<KeybindingsView>("GET", "/api/keybindings", undefined, signal),
  threadItem: (threadId: string, itemId: string, signal?: AbortSignal) =>
    request<unknown>("GET", `/api/threads/${q(threadId)}/items/${q(itemId)}`, undefined, signal),
  regenerateTitle: (id: string) => request<Thread>("POST", `/api/threads/${q(id)}/title`),
  reorderThreads: (ids: string[]) => request<void>("POST", "/api/threads/order", { ids }),
  archivedThreads: (projectId: string, signal?: AbortSignal) =>
    request<Thread[]>("GET", `/api/threads?project_id=${q(projectId)}&archived=true`, undefined, signal),
  mentions: (threadId: string, query: string, signal?: AbortSignal) =>
    request<Mentions>("GET", `/api/threads/${q(threadId)}/mentions?q=${q(query)}`, undefined, signal),
  commands: (threadId: string, signal?: AbortSignal) =>
    request<SlashCommand[]>("GET", `/api/threads/${q(threadId)}/commands`, undefined, signal),
  uploadAttachment: async (threadId: string, file: File): Promise<Attachment> => {
    let response: Response;
    try {
      response = await fetch(`/api/threads/${q(threadId)}/attachments?name=${q(file.name)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { ...authHeaders(), "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
    } catch {
      throw new ApiFailure(NETWORK_ERROR, "Can't reach the Orbyn service.", 0);
    }
    if (!response.ok) throw await failureFrom(response);
    return (await response.json()) as Attachment;
  },

  usage: (days: number, signal?: AbortSignal) =>
    request<UsageReport>("GET", `/api/usage?days=${days}`, undefined, signal),
  refreshUsage: (days: number) => request<UsageReport>("POST", `/api/usage/refresh?days=${days}`),
  limits: (force: boolean, signal?: AbortSignal) =>
    request<LimitsOverview>("GET", `/api/limits${force ? "?force=true" : ""}`, undefined, signal),
  updates: (signal?: AbortSignal) => request<UpdateStatus>("GET", "/api/updates", undefined, signal),
  checkUpdates: () => request<UpdateStatus>("POST", "/api/updates/check"),
  applyAppUpdate: () => request<void>("POST", "/api/updates/app/apply"),
  applyAllUpdates: () => request<ApplyAllResult>("POST", "/api/updates/apply-all"),
  settings: (signal?: AbortSignal) =>
    request<ServerSettings>("GET", "/api/settings", undefined, signal),
  putSettings: (body: ServerSettings) => request<ServerSettings>("PUT", "/api/settings", body),

  workspace: (signal?: AbortSignal) =>
    request<WorkspaceStatus>("GET", "/api/workspace", undefined, signal),
  setupWorkspace: (body: WorkspaceSetup) =>
    request<WorkspaceStatus>("POST", "/api/workspace/setup", body),
  updateLibrary: (apply: boolean) =>
    request<LibraryUpdateResult>("POST", "/api/workspace/update", { apply }),
  rollbackLibrary: () => request<LibraryUpdateResult>("POST", "/api/workspace/rollback"),
  createProject: (name: string) => request<Project>("POST", "/api/projects/create", { name, readme: true }),
  addProject: (path: string) => request<Project>("POST", "/api/projects/add", { path }),
  clones: (signal?: AbortSignal) => request<CloneJob[]>("GET", "/api/clones", undefined, signal),
  startClone: (url: string) => request<CloneJob>("POST", "/api/clones", { url }),
  removeProject: (id: string, confirm: boolean) =>
    request<ProjectRemoval>("DELETE", `/api/projects/${q(id)}${confirm ? "?confirm=true" : ""}`),

  info: (signal?: AbortSignal) => request<ServerInfo>("GET", "/api/info", undefined, signal),
  signIn: (key: string) => request<void>("POST", "/auth/session", { key }),

  projects: (signal?: AbortSignal) => request<Project[]>("GET", "/api/projects", undefined, signal),
  trustProject: (id: string) => request<Project>("POST", `/api/projects/${q(id)}/trust`),
  browse: (path: string | null, signal?: AbortSignal) =>
    request<FsListing>("GET", `/api/fs/browse${path ? `?path=${q(path)}` : ""}`, undefined, signal),

  threads: (projectId: string, signal?: AbortSignal) =>
    request<Thread[]>("GET", `/api/threads?project_id=${q(projectId)}`, undefined, signal),
  editors: (signal?: AbortSignal) => request<EditorInfo[]>("GET", "/api/editors", undefined, signal),
  openInEditor: (threadId: string, body: { path: string; editor: string; line?: number; column?: number }) =>
    request<void>("POST", `/api/threads/${q(threadId)}/files/open`, body),
  allThreads: (signal?: AbortSignal) => request<Thread[]>("GET", "/api/threads", undefined, signal),
  adoptScratch: (threadId: string) => request<Project>("POST", `/api/threads/${q(threadId)}/adopt`, {}),
  thread: (id: string, signal?: AbortSignal) =>
    request<Thread>("GET", `/api/threads/${q(id)}`, undefined, signal),
  createThread: (body: CreateThread) => request<Thread>("POST", "/api/threads", body),
  deleteThread: (id: string) => request<void>("DELETE", `/api/threads/${q(id)}`),
  startRun: (
    threadId: string,
    prompt: string,
    attachmentIds: string[] = [],
    turn: {
      model?: string;
      effort?: string;
      permission_mode?: PermissionMode;
      options?: Record<string, string>;
    } = {},
  ) =>
    request<Run>("POST", `/api/threads/${q(threadId)}/runs`, {
      prompt,
      ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
      ...turn,
    }),
  searchMessages: (query: string, signal?: AbortSignal) =>
    request<MessageSearch>("GET", `/api/search/messages?q=${q(query)}&limit=20`, undefined, signal),
  cancelRun: (runId: string) => request<void>("POST", `/api/runs/${q(runId)}/cancel`),
  forceStop: (threadId: string) => request<unknown>("POST", `/api/threads/${q(threadId)}/force-stop`, {}),
  diff: (threadId: string, signal?: AbortSignal, scope?: string) =>
    request<FileDiff[]>("GET", `/api/threads/${q(threadId)}/diff${scope ? `?scope=${scope}` : ""}`, undefined, signal),
  checkpoints: (threadId: string, signal?: AbortSignal) =>
    request<Checkpoint[]>("GET", `/api/threads/${q(threadId)}/checkpoints`, undefined, signal),
  runChanges: (threadId: string, runId: string, signal?: AbortSignal) =>
    request<RunChanges>("GET", `/api/threads/${q(threadId)}/runs/${q(runId)}/changes`, undefined, signal),
  restoreChanges: (threadId: string, runId: string, paths: string[]) =>
    request<RestoredFile[]>("POST", `/api/threads/${q(threadId)}/runs/${q(runId)}/changes/restore`, { point: "start", paths }),
  rewindThread: (threadId: string, runId: string, restoreFiles: boolean) =>
    request<void>("POST", `/api/threads/${q(threadId)}/rewind`, { run_id: runId, restore_files: restoreFiles }),
  forkThread: (threadId: string, runId: string) =>
    request<Thread>("POST", `/api/threads/${q(threadId)}/fork`, { run_id: runId }),
  forkBefore: (threadId: string, runId: string) =>
    request<Thread>("POST", `/api/threads/${q(threadId)}/fork`, { run_id: runId, before: true }),
  startSideChat: (threadId: string) => request<Thread>("POST", `/api/threads/${q(threadId)}/fork`, { side: true }),
  bringBack: (sideId: string) => request<void>("POST", `/api/threads/${q(sideId)}/bring-back`),

  pendingApprovals: (signal?: AbortSignal) =>
    request<Approval[]>("GET", "/api/approvals?state=pending", undefined, signal),
  decideApproval: (id: string, allow: boolean, remember: boolean, feedback?: string) =>
    request<Approval>("POST", `/api/approvals/${q(id)}/decide`, { allow, remember, ...(feedback ? { feedback } : {}) }),

  engines: (signal?: AbortSignal) =>
    request<EngineStatus[]>("GET", "/api/engines", undefined, signal),
  models: (engine: string, signal?: AbortSignal) =>
    request<EngineModels>("GET", `/api/engines/${q(engine)}/models`, undefined, signal),
  switchEngine: (threadId: string, engine: string, model: string | null) =>
    request<Thread>("POST", `/api/threads/${q(threadId)}/switch-engine`, { engine, model }),
  refreshEngines: () => request<EngineStatus[]>("POST", "/api/engines/refresh"),
  updateEngine: (id: string) => request<void>("POST", `/api/engines/${q(id)}/update`),
  addCustomEngine: (body: CustomEngine) =>
    request<EngineStatus>("POST", "/api/engines/custom", body),
  removeCustomEngine: (id: string) => request<void>("DELETE", `/api/engines/custom/${q(id)}`),

  gitAction: (threadId: string, body: GitAction) =>
    request<GitActionResult>("POST", `/api/threads/${q(threadId)}/git/action`, body),
  branches: (threadId: string, signal?: AbortSignal) =>
    request<BranchInfo[]>("GET", `/api/threads/${q(threadId)}/branches`, undefined, signal),
  createBranch: (threadId: string, name: string) =>
    request<void>("POST", `/api/threads/${q(threadId)}/branches`, { name }),
  switchBranch: (threadId: string, name: string) =>
    request<void>("POST", `/api/threads/${q(threadId)}/branches/switch`, { name }),
  publishProject: (projectId: string, body: PublishProject) =>
    request<void>("POST", `/api/projects/${q(projectId)}/publish`, body),
  restoreWorkspace: (threadId: string, runId: string, point: RestorePoint) =>
    request<void>("POST", `/api/threads/${q(threadId)}/restore`, { run_id: runId, point }),



};

export type { JsonValue };
