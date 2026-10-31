import { readToken } from "./token";
import type {
  ApplyAllResult,
  Approval,
  Attachment,
  CreateThread,
  CustomEngine,
  EngineStatus,
  FileDiff,
  FsListing,
  ImportReport,
  JsonValue,
  LibraryUpdateResult,
  LimitsOverview,
  Mentions,
  Project,
  ProjectRemoval,
  QueuedMessage,
  Run,
  ServerInfo,
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
    request<void>("POST", `/api/threads/${q(threadId)}/steer`, { prompt }),
  patchThread: (id: string, body: UpdateThread) =>
    request<Thread>("PATCH", `/api/threads/${q(id)}`, body),
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
  cloneProject: (url: string) => request<Project>("POST", "/api/projects/clone", { url }),
  createProject: (name: string) => request<Project>("POST", "/api/projects/create", { name }),
  importProject: (path: string) => request<ImportReport>("POST", "/api/projects/import", { path }),
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
  thread: (id: string, signal?: AbortSignal) =>
    request<Thread>("GET", `/api/threads/${q(id)}`, undefined, signal),
  createThread: (body: CreateThread) => request<Thread>("POST", "/api/threads", body),
  deleteThread: (id: string) => request<void>("DELETE", `/api/threads/${q(id)}`),
  startRun: (threadId: string, prompt: string, attachmentIds: string[] = []) =>
    request<Run>("POST", `/api/threads/${q(threadId)}/runs`, {
      prompt,
      ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
    }),
  cancelRun: (runId: string) => request<void>("POST", `/api/runs/${q(runId)}/cancel`),
  diff: (threadId: string, signal?: AbortSignal) =>
    request<FileDiff[]>("GET", `/api/threads/${q(threadId)}/diff`, undefined, signal),

  pendingApprovals: (signal?: AbortSignal) =>
    request<Approval[]>("GET", "/api/approvals?state=pending", undefined, signal),
  decideApproval: (id: string, allow: boolean, remember: boolean) =>
    request<Approval>("POST", `/api/approvals/${q(id)}/decide`, { allow, remember }),

  engines: (signal?: AbortSignal) =>
    request<EngineStatus[]>("GET", "/api/engines", undefined, signal),
  refreshEngines: () => request<EngineStatus[]>("POST", "/api/engines/refresh"),
  updateEngine: (id: string) => request<void>("POST", `/api/engines/${q(id)}/update`),
  addCustomEngine: (body: CustomEngine) =>
    request<EngineStatus>("POST", "/api/engines/custom", body),
  removeCustomEngine: (id: string) => request<void>("DELETE", `/api/engines/custom/${q(id)}`),



};

export type { JsonValue };
