import { request } from "../../api/client";
import type {
  ForgeStatus,
  PullCheck,
  PullConversation,
  PullFile,
  PullList,
  PullRequest,
  PullRequestDetail,
  PullTimelineEvent,
} from "../../api/types";

const q = encodeURIComponent;
const base = (projectId: string, number: number) => `/api/projects/${q(projectId)}/pulls/${number}`;

export const pullsApi = {
  forges: (signal?: AbortSignal) => request<ForgeStatus[]>("GET", "/api/forges", undefined, signal),
  list: (state: string, query: string, signal?: AbortSignal) =>
    request<PullList>("GET", `/api/pulls?state=${q(state)}&q=${q(query)}`, undefined, signal),
  detail: (projectId: string, number: number, signal?: AbortSignal) =>
    request<PullRequestDetail>("GET", base(projectId, number), undefined, signal),
  checks: (projectId: string, number: number, signal?: AbortSignal) =>
    request<PullCheck[]>("GET", `${base(projectId, number)}/checks`, undefined, signal),
  timeline: (projectId: string, number: number, signal?: AbortSignal) =>
    request<PullTimelineEvent[]>("GET", `${base(projectId, number)}/timeline`, undefined, signal),
  files: (projectId: string, number: number, signal?: AbortSignal) =>
    request<PullFile[]>("GET", `${base(projectId, number)}/files`, undefined, signal),
  conversation: (projectId: string, number: number, signal?: AbortSignal) =>
    request<PullConversation>("GET", `${base(projectId, number)}/comments`, undefined, signal),
  comment: (projectId: string, number: number, body: string) =>
    request<void>("POST", `${base(projectId, number)}/comments`, { body }),
  review: (projectId: string, number: number, event: string, body: string) =>
    request<void>("POST", `${base(projectId, number)}/review`, { event, body }),
  merge: (projectId: string, number: number, method: string, deleteBranch: boolean) =>
    request<void>("POST", `${base(projectId, number)}/merge`, {
      method,
      auto: false,
      delete_branch: deleteBranch,
      strip_credits: false,
    }),
  action: (projectId: string, number: number, action: string) =>
    request<void>("POST", `${base(projectId, number)}/action`, { action }),
  work: (projectId: string, number: number) =>
    request<{ id: string }>("POST", `${base(projectId, number)}/work`, {}),
  projectPulls: (projectId: string, query: string, signal?: AbortSignal) =>
    request<PullRequest[]>("GET", `/api/projects/${q(projectId)}/pulls?state=open&q=${q(query)}`, undefined, signal),
  linked: (threadId: string, signal?: AbortSignal) =>
    request<PullRequest[]>("GET", `/api/threads/${q(threadId)}/pulls`, undefined, signal),
  refreshLinked: (threadId: string) =>
    request<PullRequest[]>("POST", `/api/threads/${q(threadId)}/pulls/refresh`),
  link: (threadId: string, number: number) =>
    request<void>("POST", `/api/threads/${q(threadId)}/pulls`, { number }),
};
