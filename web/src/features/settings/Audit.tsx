import { useMemo, useState } from "react";
import { api } from "../../api/client";
import type { PolicyEffect } from "../../api/types";
import { fullTime } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Field, Pill } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";

const LIMITS = [100, 500, 1000];
type DecisionFilter = PolicyEffect | "any";

export function AuditSection() {
  const threads = useWorkspace((state) => state.threads);
  const [threadId, setThreadId] = useState("");
  const [limit, setLimit] = useState(100);
  const [decision, setDecision] = useState<DecisionFilter>("any");
  const [text, setText] = useState("");
  const audit = useAsync(`audit:${threadId}:${limit}`, (signal) =>
    api.audit(threadId || null, limit, signal),
  );

  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return (audit.data ?? []).filter(
      (row) =>
        (decision === "any" || row.decision === decision) &&
        (!needle || `${row.action} ${row.target} ${row.actor}`.toLowerCase().includes(needle)),
    );
  }, [audit.data, decision, text]);

  const threadOptions = useMemo(
    () => Object.values(threads).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [threads],
  );

  return (
    <>
      <div className="section-bar">
        <h1 tabIndex={-1} data-page-title>
          Audit
        </h1>
      </div>
      <p className="lede">Written before each effect and never changed. Newest first.</p>
      <div className="audit-filters">
        <Field label="Thread">
          {(props) => (
            <select {...props} value={threadId} onChange={(event) => setThreadId(event.target.value)}>
              <option value="">All threads</option>
              {threadOptions.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Decision">
          {(props) => (
            <select
              {...props}
              value={decision}
              onChange={(event) => setDecision(event.target.value as DecisionFilter)}
            >
              <option value="any">Any</option>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          )}
        </Field>
        <Field label="Search">
          {(props) => (
            <input {...props} type="search" value={text} onChange={(event) => setText(event.target.value)} />
          )}
        </Field>
        <Field label="Rows">
          {(props) => (
            <select {...props} value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {LIMITS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {audit.status === "loading" ? (
        <Loading label="Loading audit log" rows={8} />
      ) : audit.status === "error" ? (
        <ErrorState title="Couldn't load the audit log" failure={audit.error} onRetry={audit.reload} />
      ) : rows.length === 0 ? (
        <Empty title={audit.data.length === 0 ? "No audit rows yet" : "No matching rows"} />
      ) : (
        <ul className="audit-list">
          {rows.map((row) => (
            <li key={row.id}>
              <details>
                <summary>
                  <time dateTime={row.ts}>{fullTime(row.ts)}</time>
                  <span className="audit-action">{row.action}</span>
                  <code className="audit-target">{row.target}</code>
                  {row.decision ? (
                    <Pill tone={row.decision === "deny" ? "danger" : row.decision === "ask" ? "info" : "neutral"}>
                      {row.decision}
                    </Pill>
                  ) : null}
                </summary>
                <dl className="facts">
                  <div>
                    <dt>Actor</dt>
                    <dd>{row.actor}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{row.source}</dd>
                  </div>
                  <div>
                    <dt>Run</dt>
                    <dd>
                      <code>{row.run_id ?? "None"}</code>
                    </dd>
                  </div>
                </dl>
                <pre tabIndex={0}>{JSON.stringify(row.detail, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
