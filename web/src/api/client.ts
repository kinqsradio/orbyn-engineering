import { readToken } from "./token";
import type {
  Approval,
  ComputerStatus,
  CreatePolicyRule,
  CreateThread,
  CustomEngine,
  EngineStatus,
  FileDiff,
  FsEntry,
  FsListing,
  JsonValue,
  PolicyRule,
  Project,
  Run,
  ServerInfo,
  SkillPackStatus,
  SkillProfile,
  Thread,
  WireAuditEvent,
} from "./types";

/** A failed request. `code` is the server's stable code, or a local one below. */
export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
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
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.code === "string") {
      code = body.code;
      if (typeof body.message === "string") message = body.message;
    }
  } catch {
    // Not an ApiError body; the status is all there is.
  }
  return new ApiFailure(code, message, response.status);
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

function parseListing(value: unknown): FsListing {
  if (!isRecord(value) || typeof value.path !== "string" || !Array.isArray(value.entries)) {
    throw new ApiFailure("bad_response", "The folder list could not be read.", 200);
  }
  const entries: FsEntry[] = [];
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.path !== "string") {
      continue;
    }
    if (entry.is_dir === false) continue;
    entries.push({ name: entry.name, path: entry.path, is_git: entry.is_git === true });
  }
  return {
    path: value.path,
    parent: typeof value.parent === "string" ? value.parent : null,
    entries,
  };
}

export const api = {
  info: (signal?: AbortSignal) => request<ServerInfo>("GET", "/api/info", undefined, signal),
  signIn: (key: string) => request<void>("POST", "/auth/session", { key }),

  projects: (signal?: AbortSignal) => request<Project[]>("GET", "/api/projects", undefined, signal),
  addProject: (path: string) => request<Project>("POST", "/api/projects", { path }),
  trustProject: (id: string) => request<Project>("POST", `/api/projects/${q(id)}/trust`),
  browse: async (path: string | null, signal?: AbortSignal) =>
    parseListing(
      await request<unknown>(
        "GET",
        `/api/fs/browse${path ? `?path=${q(path)}` : ""}`,
        undefined,
        signal,
      ),
    ),

  threads: (projectId: string, signal?: AbortSignal) =>
    request<Thread[]>("GET", `/api/threads?project_id=${q(projectId)}`, undefined, signal),
  thread: (id: string, signal?: AbortSignal) =>
    request<Thread>("GET", `/api/threads/${q(id)}`, undefined, signal),
  createThread: (body: CreateThread) => request<Thread>("POST", "/api/threads", body),
  deleteThread: (id: string) => request<void>("DELETE", `/api/threads/${q(id)}`),
  startRun: (threadId: string, prompt: string) =>
    request<Run>("POST", `/api/threads/${q(threadId)}/runs`, { prompt }),
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

  skills: (signal?: AbortSignal) =>
    request<SkillPackStatus>("GET", "/api/skills", undefined, signal),
  rebuildSkills: () => request<SkillPackStatus>("POST", "/api/skills/rebuild"),
  profiles: (signal?: AbortSignal) =>
    request<SkillProfile[]>("GET", "/api/skills/profiles", undefined, signal),
  createProfile: (body: SkillProfile) =>
    request<SkillProfile>("POST", "/api/skills/profiles", body),
  deleteProfile: (id: string) => request<void>("DELETE", `/api/skills/profiles/${q(id)}`),

  rules: (signal?: AbortSignal) =>
    request<PolicyRule[]>("GET", "/api/policy/rules", undefined, signal),
  createRule: (body: CreatePolicyRule) => request<PolicyRule>("POST", "/api/policy/rules", body),
  deleteRule: (id: string) => request<void>("DELETE", `/api/policy/rules/${q(id)}`),

  audit: (threadId: string | null, limit: number, signal?: AbortSignal) =>
    request<WireAuditEvent[]>(
      "GET",
      `/api/audit?limit=${limit}${threadId ? `&thread_id=${q(threadId)}` : ""}`,
      undefined,
      signal,
    ),

  computer: (signal?: AbortSignal) =>
    request<ComputerStatus>("GET", "/api/computer", undefined, signal),
};

export type { JsonValue };
