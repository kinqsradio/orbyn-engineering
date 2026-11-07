import { CircleAlert, CloudOff, Loader2 } from "lucide-react";
import { inDesktopApp } from "../../api/shell";
import { checkConnectionNow, useConnection, useConnectionKind } from "../../state/connection";
import { Button } from "../../ui/controls";

/** The header's word for a connection failure, in place of the run state. Null when all is well. */
export function ConnectionStatus() {
  const kind = useConnectionKind();
  const restarting = useConnection((state) => state.restarting);
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
      <span className="conn-pill" data-tone={restarting ? "info" : "err"}>
        <i aria-hidden />
        {restarting ? "Restarting" : "Paused"}
      </span>
    );
  }
  return null;
}

/** Above the composer when the Orbyn service does not answer. Offline is told by the header alone. */
export function ServiceDownBanner() {
  const kind = useConnectionKind();
  const restarting = useConnection((state) => state.restarting);
  const remote = useConnection((state) => state.remote);
  if (kind !== "service-down") return null;
  // The desktop app's menu restarts the service. "Restart service" and "Show log" return to this
  // banner once an approved desktop route exists: the service is down here, so it can't carry them.
  const menu = !remote && inDesktopApp();
  if (restarting) {
    return (
      <div className="conn-banner" data-tone="info" role="status">
        <Loader2 size={13} className="spin" aria-hidden />
        <div>Restarting the Orbyn service. Your drafts are kept.</div>
      </div>
    );
  }
  return (
    <div className="conn-banner" data-tone="err" role="status">
      <CircleAlert size={13} aria-hidden />
      <div>
        <b>Can’t reach the Orbyn service on this Mac.</b>{" "}
        <span className="conn-banner-detail">Threads, files and the terminal are paused.</span>
        {menu ? <div className="conn-banner-detail">To restart the service, use the app’s menu: Orbyn › Restart service.</div> : null}
      </div>
      <div className="conn-banner-end">
        <Button small tone="primary" onClick={checkConnectionNow}>Check again</Button>
      </div>
    </div>
  );
}
