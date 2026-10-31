import { Hand } from "lucide-react";
import { routeHref } from "../../state/route";
import { useWorkspace } from "../../state/workspace";

export function ApprovalsLink({ compact, current }: { compact?: boolean; current?: boolean }) {
  const count = useWorkspace((state) => state.approvals.data?.length ?? 0);
  const label = count === 1 ? "1 pending approval" : `${count} pending approvals`;
  if (compact) {
    if (count === 0) return null;
    return (
      <a className="icon-btn approvals-compact" href={routeHref({ name: "approvals" })} aria-label={label} title={label}>
        <Hand size={16} aria-hidden />
        <span className="count count-warn" aria-hidden>
          {count}
        </span>
      </a>
    );
  }
  return (
    <a
      className="nav-row"
      href={routeHref({ name: "approvals" })}
      aria-current={current ? "page" : undefined}
      aria-label={count > 0 ? `Approvals, ${label}` : "Approvals"}
    >
      <Hand size={16} aria-hidden />
      <span>Approvals</span>
      {count > 0 ? (
        <span className="count count-warn" aria-hidden>
          {count}
        </span>
      ) : null}
    </a>
  );
}
