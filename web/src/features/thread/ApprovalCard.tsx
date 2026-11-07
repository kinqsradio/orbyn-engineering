import { CircleCheck, CircleSlash, Clock, FileDiff, SquareTerminal, Wrench } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { Approval, JsonValue } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { ConfirmDialog } from "../../ui/Dialog";
import { Menu } from "../../ui/Menu";
import { Presence } from "../../ui/Presence";
import { touchesOf } from "./approvalDetail";
import { approvalFromContent } from "./projection";

const outcome = {
  allowed: { icon: CircleCheck, label: "Approved" },
  denied: { icon: CircleSlash, label: "Declined" },
  expired: { icon: Clock, label: "Expired" },
} as const;

const kindIcon = (kind: Approval["kind"]) =>
  kind === "command" ? SquareTerminal : kind === "file_change" ? FileDiff : Wrench;

const kindLabel: Partial<Record<Approval["kind"], string>> = { command: "command", file_change: "file change" };

/** An approval as a work row: what it would do, then More, Always allow this command, Deny and Allow. */
export function ApprovalCard({ approval, minimapKey }: { approval: Approval; minimapKey?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const putReceipt = useWorkspace((state) => state.putReceipt);
  const refreshApprovals = useWorkspace((state) => state.refreshApprovals);
  const touches = touchesOf(approval.detail)
    .filter((touch) => touch.label !== "Address" && touch.label !== "Folder")
    .flatMap((touch) => touch.values);
  const targets = touches.length > 0 ? touches : [approval.summary];
  const commandText = targets[0] ?? approval.summary;
  const engine = useWorkspace((state) => state.threads[approval.thread_id]?.engine ?? "this engine");
  const foreverText = `Allow ${commandText} for ${engine} in every project from now on`;
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
  const reaches = touchesOf(approval.detail).filter((touch) => touch.label === "Address" || touch.label === "Folder");
  const why = approval.summary && !targets.includes(approval.summary) ? approval.summary : null;
  return (
    <article className="approval" data-minimap={minimapKey} data-pending={decided ? undefined : ""} aria-label={approval.summary} tabIndex={decided ? undefined : -1}>
      {decided ? null : (
        <div className="approval-top">
          <p className="ask-label">
            <span className="status-dot" aria-hidden />
            Needs you · {kindLabel[approval.kind] ?? "tool"}
          </p>
          <span className="approval-wait">Waiting for approval</span>
        </div>
      )}
      <div className="approval-targets">
        {targets.map((value, at) => (
          <p key={value} className={at === 0 ? "approval-target" : "approval-target approval-more-target"}>
            {at === 0 ? <Icon size={14} aria-hidden /> : null}
            <code>{value}</code>
          </p>
        ))}
      </div>
      {decided ? null : (
        <>
          {why ? (
            <p className="approval-kv">
              <span>Why</span>
              <b>{why}</b>
            </p>
          ) : null}
          {reaches.map((touch) => (
            <p key={touch.label} className="approval-kv">
              <span>{touch.label === "Address" ? "Reaches" : "Runs in"}</span>
              <b className="mono">{touch.values.join(", ")}</b>
            </p>
          ))}
        </>
      )}
      {decided ? (
        <p className="approval-line">
          <decided.icon size={12} aria-hidden />
          {decided.label}
        </p>
      ) : (
        <div className="approval-line">
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
          <button
            type="button"
            className="approval-always"
            disabled={busy}
            title={foreverText}
            aria-description={foreverText}
            onClick={() => setConfirming(true)}
          >
            Always allow this command
          </button>
          <button type="button" disabled={busy} onClick={() => void decide(false, false)}>
            Deny
          </button>
          <button type="button" className="approval-primary" disabled={busy} onClick={() => void decide(true, false)}>
            Allow
          </button>
        </div>
      )}
      {confirming ? (
        <ConfirmDialog
          title={`Always allow ${commandText}?`}
          confirmLabel="Always allow"
          cancelFocus
          onConfirm={() => decide(true, true)}
          onClose={() => setConfirming(false)}
        >
          <p>Applies in every project.</p>
        </ConfirmDialog>
      ) : null}
      <Presence>{more ? (
        <Menu
          {...more}
          label="More approval options"
          onClose={() => setMore(null)}
          items={[
            { label: "Cancel", onSelect: cancelRun },
          ]}
        />
      ) : null}</Presence>
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
