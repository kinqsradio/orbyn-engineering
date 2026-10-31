import { Hand } from "lucide-react";
import { routeHref } from "../../state/route";
import { useWorkspace } from "../../state/workspace";

/** The global count. Icon-sized, so it fits the sidebar foot and the phone header. */
export function ApprovalsLink({ current }: { current?: boolean }) {
  const count = useWorkspace((state) => state.approvals.data?.length ?? 0);
  const label = count === 1 ? "1 pending approval" : `${count} pending approvals`;
  return (
    <a
      className="icon-btn approvals-link"
      href={routeHref({ name: "approvals" })}
      aria-current={current ? "page" : undefined}
      aria-label={count > 0 ? `Approvals, ${label}` : "Approvals"}
      title={count > 0 ? label : "Approvals"}
    >
      <Hand size={16} aria-hidden />
      {count > 0 ? (
        <span className="count" aria-hidden>
          {count}
        </span>
      ) : null}
    </a>
  );
}
