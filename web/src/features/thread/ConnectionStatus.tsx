import { CircleAlert, CloudOff } from "lucide-react";
import { useConnectionKind } from "../../state/connection";

/** The header's word for a connection failure, in place of the run state. Null when all is well. */
export function ConnectionStatus() {
  const kind = useConnectionKind();
  if (kind === "offline") {
    return (
      <span className="page-sub-item conn-status">
        <CloudOff size={13} aria-hidden />
        Offline
      </span>
    );
  }
  if (kind === "service-down") {
    return (
      <span className="conn-pill" data-tone="err">
        <i aria-hidden />
        Paused
      </span>
    );
  }
  return null;
}

/** Above the composer when the Orbyn service does not answer. Offline is told by the header alone. */
export function ServiceDownBanner() {
  const kind = useConnectionKind();
  if (kind !== "service-down") return null;
  return (
    <div className="conn-banner" data-tone="err" role="status">
      <CircleAlert size={13} aria-hidden />
      <div>
        <b>Can’t reach the Orbyn service on this Mac.</b>{" "}
        <span className="conn-banner-detail">Threads, files and the terminal are paused.</span>
      </div>
    </div>
  );
}
