import { CircleAlert, CircleCheck, CircleSlash, Clock } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { Approval } from "../../api/types";
import { actionLabels, fullTime, relativeTime } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Button, Pill } from "../../ui/controls";
import { touchesOf } from "./approvalDetail";

type Decision = "allow" | "deny" | "always";

const outcome = {
  allowed: { icon: CircleCheck, label: "Allowed" },
  denied: { icon: CircleSlash, label: "Denied" },
  expired: { icon: Clock, label: "Expired" },
} as const;

export function ApprovalCard({
  approval,
  engine,
  source,
}: {
  approval: Approval;
  /** Engine name, shown because the decision is about what it will do. */
  engine: string | null;
  /** Where this request came from, for lists outside its thread. */
  source?: { label: string; href: string };
}) {
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const putReceipt = useWorkspace((state) => state.putReceipt);
  const refreshApprovals = useWorkspace((state) => state.refreshApprovals);
  const touches = touchesOf(approval.detail);

  const decide = async (decision: Decision) => {
    setPending(decision);
    setError(null);
    try {
      const decided = await api.decideApproval(approval.id, decision !== "deny", decision === "always");
      putReceipt(decided);
    } catch (failure) {
      const known = toFailure(failure);
      // The first decision won. The log and approvals list carry its outcome.
      if (known.code === "already_decided") {
        setError("This approval was already decided.");
        void refreshApprovals();
      } else {
        setError(`${known.message} Your decision may not have been recorded. Try again.`);
      }
    } finally {
      setPending(null);
    }
  };

  const decided = approval.state === "pending" ? null : outcome[approval.state];

  return (
    <article
      className={`approval ${decided ? "approval-closed" : ""}`}
      aria-label={`Approval: ${approval.summary}`}
    >
      <header className="approval-head">
        {decided ? (
          <decided.icon size={16} aria-hidden />
        ) : (
          <CircleAlert size={16} className="approval-icon" aria-hidden />
        )}
        <h3>{approval.summary}</h3>
        {decided ? <Pill>{decided.label}</Pill> : <Pill tone="warn">Needs your decision</Pill>}
      </header>
      <dl className="approval-meta">
        <div>
          <dt>Action</dt>
          <dd>{actionLabels[approval.kind]}</dd>
        </div>
        {engine ? (
          <div>
            <dt>Engine</dt>
            <dd>{engine}</dd>
          </div>
        ) : null}
        <div>
          <dt>Asked</dt>
          <dd>
            <time dateTime={approval.created_at} title={fullTime(approval.created_at)}>
              {relativeTime(approval.created_at)}
            </time>
          </dd>
        </div>
        {source ? (
          <div>
            <dt>Thread</dt>
            <dd>
              <a href={source.href}>{source.label}</a>
            </dd>
          </div>
        ) : null}
      </dl>
      {touches.length > 0 ? (
        <dl className="approval-touches">
          {touches.map((touch) => (
            <div key={touch.label}>
              <dt>{touch.label}</dt>
              {touch.values.map((value) => (
                <dd key={value}>
                  <code>{value}</code>
                </dd>
              ))}
            </div>
          ))}
        </dl>
      ) : null}
      {touches.length === 0 && approval.detail !== null ? (
        <details className="plain-details">
          <summary>Request details</summary>
          <pre tabIndex={0}>{JSON.stringify(approval.detail, null, 2)}</pre>
        </details>
      ) : null}
      {decided ? null : (
        <>
          <div className="approval-actions">
            <Button tone="primary" small busy={pending === "allow"} disabled={pending !== null} onClick={() => void decide("allow")}>
              Allow
            </Button>
            <Button small tone="danger" busy={pending === "deny"} disabled={pending !== null} onClick={() => void decide("deny")}>
              Deny
            </Button>
            <Button small tone="quiet" busy={pending === "always"} disabled={pending !== null} onClick={() => void decide("always")}>
              Always allow this
            </Button>
          </div>
          <p className="approval-note">Always allow stores a rule for this exact target in Policy.</p>
        </>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** Pending list wins, then this client's receipt, then the logged snapshot. */
export function useResolvedApproval(logged: Approval): Approval {
  const receipt = useWorkspace((state) => state.receipts[logged.id]);
  const live = useWorkspace((state) => state.approvals.data?.find((a) => a.id === logged.id));
  return live ?? receipt ?? logged;
}
