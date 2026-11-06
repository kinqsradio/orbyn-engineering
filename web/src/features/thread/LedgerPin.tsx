import { Button } from "../../ui/controls";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";

/**
 * The Ledger layout pins what the thread is waiting on above the transcript, so the
 * decision stays in view however far the person has scrolled. It only points at the
 * decision: approving and declining stay on the card itself, where the detail is.
 */
export function LedgerPin({ threadId }: { threadId: string }) {
  const layout = useUi((state) => state.workspaceLayout);
  const approvals = useWorkspace((state) => state.approvals.data);
  const pending = (approvals ?? []).filter(
    (approval) =>
      approval.thread_id === threadId && approval.state === "pending",
  );
  const first = pending[0];
  if (layout !== "ledger" || !first) return null;
  const show = () => {
    const card = document.querySelector<HTMLElement>(
      ".transcript .approval[data-pending]",
    );
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
    card?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  };
  return (
    <div className="ledger-pin" role="status">
      <span className="status-dot" aria-hidden />
      <span className="ledger-pin-label">Needs you</span>
      <span className="ledger-pin-text">
        {pending.length > 1 ? `${pending.length} decisions waiting. ` : null}
        {first.summary}
      </span>
      <Button small tone="quiet" onClick={show}>
        Show
      </Button>
    </div>
  );
}
