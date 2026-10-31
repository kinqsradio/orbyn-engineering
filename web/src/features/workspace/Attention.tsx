import { useMemo } from "react";
import type { Thread } from "../../api/types";
import { relativeTime } from "../../lib/format";
import { routeHref } from "../../state/route";
import { engineById, useWorkspace } from "../../state/workspace";
import { LinkButton } from "../../ui/controls";
import { Empty, ErrorState, Loading, PageHeader } from "../../ui/states";
import { ApprovalCard } from "../thread/ApprovalCard";
import { RunStatePill, threadRunState } from "./RunState";

export function ApprovalsList() {
  const approvals = useWorkspace((state) => state.approvals);
  const threads = useWorkspace((state) => state.threads);
  const engines = useWorkspace((state) => state.engines.data);
  const refresh = useWorkspace((state) => state.refreshApprovals);

  if (approvals.error && !approvals.data) {
    return <ErrorState title="Couldn't load approvals" failure={approvals.error} onRetry={() => void refresh()} />;
  }
  if (!approvals.data) return <Loading label="Loading approvals" />;
  if (approvals.data.length === 0) {
    return <Empty title="No pending approvals" />;
  }
  return (
    <div className="stack">
      {approvals.data.map((approval) => {
        const thread = threads[approval.thread_id];
        return (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            engine={thread ? (engineById(engines, thread.engine)?.name ?? thread.engine) : null}
            source={
              thread
                ? { label: thread.title, href: routeHref({ name: "thread", id: thread.id }) }
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

export function ApprovalsPage() {
  return (
    <div className="page">
      <PageHeader title="Approvals" back={{ name: "home" }} backLabel="Threads" />
      <ApprovalsList />
    </div>
  );
}

/** Active, then recent problems. Finished work stays in the sidebar. */
const needsAttention = (thread: Thread) =>
  thread.active_run !== null ||
  thread.last_run_state === "failed" ||
  thread.last_run_state === "interrupted";

export function HomePage() {
  const threads = useWorkspace((state) => state.threads);
  const projects = useWorkspace((state) => state.projects);
  const count = useWorkspace((state) => state.approvals.data?.length ?? 0);
  const rows = useMemo(
    () =>
      Object.values(threads)
        .filter(needsAttention)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [threads],
  );

  return (
    <div className="page">
      <PageHeader
        title="Workspace"
        actions={
          <LinkButton tone="primary" href={routeHref({ name: "new", projectId: null })}>
            New thread
          </LinkButton>
        }
      />
      {count > 0 ? (
        <section className="section">
          <h2>Waiting for you</h2>
          <ApprovalsList />
        </section>
      ) : null}
      <section className="section">
        <h2>Active and failed runs</h2>
        {rows.length === 0 ? (
          projects.data ? (
            <Empty title="Nothing running" />
          ) : (
            <Loading label="Loading runs" rows={2} />
          )
        ) : (
          <ul className="rows">
            {rows.map((thread) => {
              const state = threadRunState(thread);
              return (
                <li key={thread.id}>
                  <a className="row-link" href={routeHref({ name: "thread", id: thread.id })}>
                    <span className="row-title">{thread.title}</span>
                    <time dateTime={thread.updated_at} className="row-meta">
                      {relativeTime(thread.updated_at)}
                    </time>
                    {state ? <RunStatePill state={state} /> : null}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
