import { CircleCheck, CircleSlash, Clock, FileDiff, SquareTerminal, Wrench } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { Approval, JsonValue } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Menu } from "../../ui/Menu";
import { touchesOf } from "./approvalDetail";
import { approvalFromContent } from "./projection";

const outcome = {
  allowed: { icon: CircleCheck, label: "Approved" },
  denied: { icon: CircleSlash, label: "Declined" },
  expired: { icon: Clock, label: "Expired" },
} as const;

const kindIcon = (kind: Approval["kind"]) =>
  kind === "command" ? SquareTerminal : kind === "file_change" ? FileDiff : Wrench;

/** An approval as a work row: what it would do, then Decline, Approve and More. */
export function ApprovalCard({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const putReceipt = useWorkspace((state) => state.putReceipt);
  const refreshApprovals = useWorkspace((state) => state.refreshApprovals);
  const touches = touchesOf(approval.detail).flatMap((touch) => touch.values);
  const Icon = kindIcon(approval.kind);

  const decide = async (allow: boolean, remember: boolean) => {
    setBusy(true);
    setError(null);
    try {
      putReceipt(await api.decideApproval(approval.id, allow, remember));
    } catch (failure) {
      const known = toFailure(failure);
      // The first decision won. The server returns that outcome with the refusal.
      if (known.code === "already_decided") {
        const existing = approvalFromContent(
          (known.detail ?? null) as JsonValue,
          approval.thread_id,
          approval.run_id,
          approval.created_at,
        );
        if (existing) putReceipt(existing);
        setError("Already decided.");
        void refreshApprovals();
      } else {
        setError(`${known.message} Try again.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = () => {
    void api.cancelRun(approval.run_id).catch((failure: unknown) => setError(toFailure(failure).message));
  };

  const decided = approval.state === "pending" ? null : outcome[approval.state];
  return (
    <article className="approval" aria-label={approval.summary}>
      <p className="approval-target">
        <Icon size={14} aria-hidden />
        <code>{touches[0] ?? approval.summary}</code>
      </p>
      {touches.slice(1).map((value) => (
        <p key={value} className="approval-target approval-more-target">
          <code>{value}</code>
        </p>
      ))}
      {decided ? (
        <p className="approval-line">
          <decided.icon size={12} aria-hidden />
          {decided.label}
        </p>
      ) : (
        <div className="approval-line">
          <span className="status-dot tone-warn" aria-hidden />
          <span className="tone-warn">Waiting for approval</span>
          <span aria-hidden>·</span>
          <button type="button" disabled={busy} onClick={() => void decide(false, false)}>
            Decline
          </button>
          <button type="button" className="approval-primary" disabled={busy} onClick={() => void decide(true, false)}>
            Approve
          </button>
          <button
            type="button"
            aria-haspopup="menu"
            disabled={busy}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMore({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            More
          </button>
        </div>
      )}
      {more ? (
        <Menu
          {...more}
          label="More approval options"
          onClose={() => setMore(null)}
          items={[
            { label: "Always allow", onSelect: () => void decide(true, true) },
            { label: "Cancel", onSelect: cancelRun },
          ]}
        />
      ) : null}
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
