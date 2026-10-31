import { request } from "../../api/client";
import type {
  ForgeStatus,
  MergePull,
  PullBulkResult,
  PullCandidate,
  PullCheck,
  PullCheckout,
  PullConversation,
  PullFile,
  PullList,
  PullRequest,
  PullRequestDetail,
  PullStack,
  PullTimelineEvent,
  PullWatch,
  ReviewLineComment,
  UpdatePull,
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
  comment: (projectId: string, number: number, body: string, replyTo?: string) =>
    request<void>("POST", `${base(projectId, number)}/comments`, { body, ...(replyTo ? { reply_to: replyTo } : {}) }),
  editComment: (projectId: string, number: number, comment: string, kind: string, body: string) =>
    request<void>("PATCH", `${base(projectId, number)}/comments/${q(comment)}`, { kind, body }),
  react: (projectId: string, number: number, comment: string, kind: string, content: string) =>
    request<void>("POST", `${base(projectId, number)}/comments/${q(comment)}/react`, { kind, content }),
  resolve: (projectId: string, number: number, thread: string, resolved: boolean) =>
    request<void>("POST", `${base(projectId, number)}/threads/${q(thread)}/resolve`, { resolved }),
  review: (projectId: string, number: number, event: string, body: string, comments: ReviewLineComment[] = []) =>
    request<void>("POST", `${base(projectId, number)}/review`, { event, body, comments }),
  update: (projectId: string, number: number, change: UpdatePull) =>
    request<void>("PATCH", base(projectId, number), change),
  merge: (projectId: string, number: number, options: MergePull) =>
    request<void>("POST", `${base(projectId, number)}/merge`, options),
  action: (projectId: string, number: number, action: string) =>
    request<void>("POST", `${base(projectId, number)}/action`, { action }),
  work: (projectId: string, number: number, engine: string) =>
    request<{ id: string }>("POST", `${base(projectId, number)}/work`, { engine }),
  checkout: (projectId: string, number: number, worktree: boolean) =>
    request<PullCheckout>("POST", `${base(projectId, number)}/checkout`, { worktree }),
  setViewed: (projectId: string, number: number, paths: string[], viewed: boolean) =>
    request<void>("POST", `${base(projectId, number)}/viewed`, { paths, viewed }),
  reviewerCandidates: (projectId: string, signal?: AbortSignal) =>
    request<PullCandidate[]>("GET", `/api/projects/${q(projectId)}/pulls/reviewers`, undefined, signal),
  labelCandidates: (projectId: string, signal?: AbortSignal) =>
    request<PullCandidate[]>("GET", `/api/projects/${q(projectId)}/pulls/labels`, undefined, signal),
  setReviewers: (projectId: string, number: number, add: string[], remove: string[]) =>
    request<void>("POST", `${base(projectId, number)}/reviewers`, { add, remove }),
  setLabels: (projectId: string, number: number, add: string[], remove: string[]) =>
    request<void>("POST", `${base(projectId, number)}/labels`, { add, remove }),
  approveWorkflow: (projectId: string, run: number) =>
    request<void>("POST", `/api/projects/${q(projectId)}/workflows/${run}/approve`),
  closeMany: (projectId: string, numbers: number[]) =>
    request<PullBulkResult[]>("POST", `/api/projects/${q(projectId)}/pulls/close`, { numbers }),
  stack: (projectId: string, number: number, signal?: AbortSignal) =>
    request<PullStack>("GET", `${base(projectId, number)}/stack`, undefined, signal),
  stackAction: (projectId: string, number: number, action: string, method?: string) =>
    request<PullBulkResult[]>("POST", `${base(projectId, number)}/stack`, { action, ...(method ? { method } : {}) }),
  projectPulls: (projectId: string, query: string, signal?: AbortSignal) =>
    request<PullRequest[]>("GET", `/api/projects/${q(projectId)}/pulls?state=open&q=${q(query)}`, undefined, signal),
  linked: (threadId: string, signal?: AbortSignal) =>
    request<PullRequest[]>("GET", `/api/threads/${q(threadId)}/pulls`, undefined, signal),
  refreshLinked: (threadId: string) =>
    request<PullRequest[]>("POST", `/api/threads/${q(threadId)}/pulls/refresh`),
  link: (threadId: string, number: number) =>
    request<void>("POST", `/api/threads/${q(threadId)}/pulls`, { number }),
  unlink: (threadId: string, number: number) => request<void>("DELETE", `/api/threads/${q(threadId)}/pulls/${number}`),
  watches: (threadId: string, signal?: AbortSignal) =>
    request<PullWatch[]>("GET", `/api/threads/${q(threadId)}/watches`, undefined, signal),
  watch: (threadId: string, number: number) => request<void>("POST", `/api/threads/${q(threadId)}/pulls/${number}/watch`),
  unwatch: (threadId: string, number: number) =>
    request<void>("DELETE", `/api/threads/${q(threadId)}/pulls/${number}/watch`),
};
