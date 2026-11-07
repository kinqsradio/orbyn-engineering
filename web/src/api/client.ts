import { serviceUrl } from "./origin";
import { readToken } from "./token";
import type { SteerResult } from "../generated/SteerResult";
import type { SkillPackStatus } from "../generated/SkillPackStatus";
import type { EngineUpdateOutcome } from "../generated/EngineUpdateOutcome";
import type { WorkflowScript } from "../generated/WorkflowScript";
import type { WorkflowStop } from "../generated/WorkflowStop";
import type { RenameSelectedProjects } from "../generated/RenameSelectedProjects";
import type { ChangeProjectIcon } from "../generated/ChangeProjectIcon";
import type { ChangeProjectImage } from "../generated/ChangeProjectImage";
import type { ChooseProjectImage } from "../generated/ChooseProjectImage";
import type { SearchProjectImages } from "../generated/SearchProjectImages";
import type { ProjectImageSearchResult } from "../generated/ProjectImageSearchResult";
import type { ProjectIconResource } from "../generated/ProjectIconResource";
import type { ResolveThreadPath } from "../generated/ResolveThreadPath";
import type { ResolvedThreadPath } from "../generated/ResolvedThreadPath";
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
  EngineFeedbackReceipt,
  EngineFeedbackRequest,
  EngineModels,
  EngineStatus,
  FileDiff,
  FsListing,
  OutsideFile,
  JsonValue,
  LibraryUpdateResult,
  LimitsOverview,
  Mentions,
  PermissionMode,
  PreviewTab,
  Project,
  ProjectRemoval,
  QueuedMessage,
  Run,
  ServerInfo,
  PublishProject,
  RestorePoint,
  ServerSettings,
  ShellAction,
  ShellStatus,
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
    response = await fetch(serviceUrl(path), {
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

/** The bytes a sent message carried. JSON requests can't carry them, so this is separate. */
export async function attachmentBlob(id: string, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(serviceUrl(`/api/attachments/${q(id)}/content`), {
      credentials: "same-origin",
      signal,
      headers: authHeaders(),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiFailure(NETWORK_ERROR, "Can't reach the Orbyn service.", 0);
  }
  if (!response.ok) {
    const failure = await failureFrom(response);
    if (response.status === 401) onUnauthorized();
    throw failure;
  }
  return response.blob();
}

const q = encodeURIComponent;

export const api = {
  /** Whether GitHub and each provider's service answer from this machine. Asked for, never polled by the service. */
  dependencyHealth: (signal?: AbortSignal) =>
    request<import("../generated/DependencyHealth").DependencyHealth>("GET", "/api/health/dependencies", undefined, signal),
  /** Whether a program path runs, and its version. Runs `--version` with no shell, for at most five seconds. */
  probeBinary: (path: string) =>
    request<import("../generated/BinaryProbe").BinaryProbe>("POST", "/api/engines/probe-binary", { path } satisfies import("../generated/ProbeBinary").ProbeBinary),
  /** How many conversations an engine keeps in its own history folder. */
  nativeSessionCount: (engineId: string, signal?: AbortSignal) =>
    request<import("./types").NativeSessionCount>("GET", `/api/engines/${q(engineId)}/native-sessions/count`, undefined, signal),
  /** What Delete now, or Delete settled worktrees, would remove: counts and sizes. Changes nothing. */
  storageCleanupPreview: (signal?: AbortSignal) =>
    request<import("./types").CleanupPreview>("GET", "/api/storage/cleanup/preview", undefined, signal),
  /** A task's last 50 firings, newest first. */
  taskRuns: (taskId: string, signal?: AbortSignal) =>
    request<import("../generated/TaskRun").TaskRun[]>("GET", `/api/tasks/${q(taskId)}/runs`, undefined, signal),
  /** Whether the webhook takes requests and its address up to the token, which is never returned. */
  taskWebhook: (taskId: string, signal?: AbortSignal) =>
    request<import("../generated/WebhookAddress").WebhookAddress>("GET", `/api/tasks/${q(taskId)}/webhook`, undefined, signal),
  /** Every scheduled task, with when it last ran. */
  tasks: (signal?: AbortSignal) => request<import("./types").ScheduledTask[]>("GET", "/api/tasks", undefined, signal),
  /** Starts a task's run now, outside its schedule. */
  runTask: (taskId: string) => request<void>("POST", `/api/tasks/${q(taskId)}/run`),
  /** What a task's webhook received, newest first, each with the sender the headers name when they name one. */
  taskDeliveries: (taskId: string, signal?: AbortSignal) =>
    request<import("../generated/WebhookDelivery").WebhookDelivery[]>("GET", `/api/tasks/${q(taskId)}/deliveries`, undefined, signal),
  /** Issues a new webhook address. The old one stops working, and the new one is returned only here. */
  rotateTaskWebhook: (taskId: string) =>
    request<import("../generated/WebhookEndpoint").WebhookEndpoint>("POST", `/api/tasks/${q(taskId)}/webhook`),
  repositoryStar: (signal?: AbortSignal) => request<import("../generated/RepositoryStarStatus").RepositoryStarStatus>("GET", "/api/source-control/repository-star", undefined, signal),
  /** An MCP App's tool call, after the person confirmed it in the host's dialog. */
  mcpAppToolCall: (threadId: string, renderId: string, name: string, args: Record<string, unknown>) =>
    request<unknown>("POST", `/api/threads/${q(threadId)}/mcp-apps/${q(renderId)}/tool-call`, {
      name,
      arguments: args,
      confirmed: true,
    }),
  /** An MCP App's message, queued as the person's own after they confirmed it. */
  mcpAppMessage: (threadId: string, renderId: string, text: string) =>
    request<QueuedMessage>("POST", `/api/threads/${q(threadId)}/mcp-apps/${q(renderId)}/message`, {
      text,
      confirmed: true,
    }),
  /** An MCP App's latest note for the model, sent with the thread's next turn. */
  mcpAppContext: (threadId: string, renderId: string, text: string) =>
    request<void>("PUT", `/api/threads/${q(threadId)}/mcp-apps/${q(renderId)}/context`, { text }),
  clearMcpAppContext: (threadId: string) => request<void>("DELETE", `/api/threads/${q(threadId)}/mcp-app-context`),
  queue: (threadId: string, signal?: AbortSignal) =>
    request<QueuedMessage[]>("GET", `/api/threads/${q(threadId)}/queue`, undefined, signal),
  enqueue: (threadId: string, prompt: string, attachmentIds: string[]) =>
    request<QueuedMessage>("POST", `/api/threads/${q(threadId)}/queue`, {
      prompt,
      attachment_ids: attachmentIds,
    }),
  jjStatus: (threadId: string, signal?: AbortSignal) =>
    request<import("../generated/JjStatus").JjStatus | null>("GET", `/api/threads/${q(threadId)}/jj`, undefined, signal),
  threadSetup: (threadId: string, signal?: AbortSignal) =>
    request<import("../generated/ThreadSetup").ThreadSetup | null>("GET", `/api/threads/${q(threadId)}/setup`, undefined, signal),
  cancelSetup: (threadId: string) =>
    request<import("../generated/ThreadSetup").ThreadSetup | null>("POST", `/api/threads/${q(threadId)}/setup/cancel`, {}),
  preparationRetry: (threadId: string, signal?: AbortSignal) => request<import("../generated/RetryPreparation").RetryPreparation | null>("GET", `/api/threads/${q(threadId)}/preparation`, undefined, signal),
  retryPreparation: (threadId: string, runId: string) => request<Run>("POST", `/api/threads/${q(threadId)}/preparation/retry`, { run_id: runId } satisfies import("../generated/RetryPreparation").RetryPreparation),
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
  /** Every archived thread, including those of a project that was removed. */
  archivedThreads: (signal?: AbortSignal) => request<Thread[]>("GET", "/api/threads?archived=true", undefined, signal),
  mentions: (threadId: string, query: string, signal?: AbortSignal) =>
    request<Mentions>("GET", `/api/threads/${q(threadId)}/mentions?q=${q(query)}`, undefined, signal),
  /** The engine's latest usage report for a thread, as the service kept it. */
  threadUsage: (threadId: string, signal?: AbortSignal) =>
    request<JsonValue | null>("GET", `/api/threads/${q(threadId)}/usage`, undefined, signal),
  commands: (threadId: string, signal?: AbortSignal) =>
    request<SlashCommand[]>("GET", `/api/threads/${q(threadId)}/commands`, undefined, signal),
  uploadAttachment: async (threadId: string, file: File): Promise<Attachment> => {
    let response: Response;
    try {
      response = await fetch(serviceUrl(`/api/threads/${q(threadId)}/attachments?name=${q(file.name)}`), {
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
  shell: (signal?: AbortSignal) => request<ShellStatus>("GET", "/api/shell", undefined, signal),
  shellAction: (action: ShellAction) => request<void>("POST", "/api/shell/actions", { action }),
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
  createProject: (name: string, path?: string) =>
    request<Project>("POST", "/api/projects/create", { name, readme: true, ...(path ? { path } : {}) }),
  addProject: (path: string) => request<Project>("POST", "/api/projects/add", { path }),
  renameSelectedProjects: (change: RenameSelectedProjects) => request<Project[]>("POST", "/api/settings/projects/rename", change),
  changeProjectIcon: (change: ChangeProjectIcon) => request<Project[]>("POST", "/api/settings/projects/icon", change),
  changeProjectImage: (change: ChangeProjectImage) => request<Project[]>("POST", "/api/settings/projects/image", change),
  /** Opens the desktop app's image dialog; `undefined` means the person cancelled. */
  chooseProjectImage: (change: ChooseProjectImage) =>
    request<Project[] | undefined>("POST", "/api/settings/projects/image/choose", change),
  searchProjectImages: (query: SearchProjectImages, signal?: AbortSignal) => request<ProjectImageSearchResult>("POST", "/api/settings/projects/image-search", query, signal),
  projectIconResource: (id: string, signal?: AbortSignal) => request<ProjectIconResource>("GET", `/api/projects/${encodeURIComponent(id)}/icon/resource`, undefined, signal),
  clones: (signal?: AbortSignal) => request<CloneJob[]>("GET", "/api/clones", undefined, signal),
  startClone: (url: string) => request<CloneJob>("POST", "/api/clones", { url }),
  cancelClone: (id: string) => request<void>("POST", `/api/clones/${q(id)}/cancel`),
  retryClone: (id: string) => request<CloneJob>("POST", `/api/clones/${q(id)}/retry`),
  removeProject: (id: string, confirm: boolean) =>
    request<ProjectRemoval>("DELETE", `/api/projects/${q(id)}${confirm ? "?confirm=true" : ""}`),

  skills: (signal?: AbortSignal) => request<SkillPackStatus>("GET", "/api/skills", undefined, signal),
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
  openPreviewFile: (threadId: string, path: string) =>
    request<PreviewTab>("POST", `/api/threads/${q(threadId)}/previews/file`, { path }),
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
  workflowScript: (threadId: string, callId: string, signal?: AbortSignal) =>
    request<WorkflowScript>("GET", `/api/threads/${q(threadId)}/workflows/${q(callId)}/script`, undefined, signal),
  stopWorkflow: (threadId: string, callId: string) =>
    request<WorkflowStop>("POST", `/api/threads/${q(threadId)}/workflows/${q(callId)}/stop`, {}),
  diff: (threadId: string, signal?: AbortSignal, scope?: string) =>
    request<FileDiff[]>("GET", `/api/threads/${q(threadId)}/diff${scope ? `?scope=${scope}` : ""}`, undefined, signal),
  readOutsideFile: (threadId: string, path: string, signal?: AbortSignal) =>
    request<OutsideFile>("GET", `/api/threads/${q(threadId)}/files/outside?path=${q(path)}`, undefined, signal),
  resolveThreadPath: (threadId: string, body: ResolveThreadPath, signal?: AbortSignal) =>
    request<ResolvedThreadPath>("POST", `/api/threads/${q(threadId)}/paths/resolve`, body, signal),
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
  models: (engine: string, signal?: AbortSignal, refresh = false) =>
    request<EngineModels>("GET", `/api/engines/${q(engine)}/models${refresh ? "?refresh=true" : ""}`, undefined, signal),
  sendFeedback: (engine: string, body: EngineFeedbackRequest) =>
    request<EngineFeedbackReceipt>("POST", `/api/engines/${q(engine)}/feedback`, body),
  switchEngine: (threadId: string, engine: string, model: string | null) =>
    request<Thread>("POST", `/api/threads/${q(threadId)}/switch-engine`, { engine, model }),
  refreshEngines: () => request<EngineStatus[]>("POST", "/api/engines/refresh"),
  updateEngine: (id: string) => request<void>("POST", `/api/engines/${q(id)}/update`),
  updateAllEngines: () => request<EngineUpdateOutcome[]>("POST", "/api/engines/update-all"),
  installRecommended: (id: string) => request<void>("POST", `/api/engines/${q(id)}/install-recommended`),
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
