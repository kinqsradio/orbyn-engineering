import { CircleAlert, CloudOff, Loader2 } from "lucide-react";
import { api } from "../../api/client";
import { inDesktopApp } from "../../api/shell";
import type { ShellAction } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useConnection, useConnectionKind } from "../../state/connection";
import { useUi } from "../../state/ui";
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
  const pushToast = useUi((state) => state.pushToast);
  if (kind !== "service-down") return null;
  // The desktop app starts the service and opens its log; a remote viewer or a plain browser can do neither.
  const controls = !remote && inDesktopApp();
  const ask = (action: ShellAction) => {
    api.shellAction(action).then(
      () => { if (action === "restart_service") useConnection.getState().setRestarting(true); },
      (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`),
    );
  };
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
      </div>
      {controls ? (
        <div className="conn-banner-end">
          <Button small onClick={() => ask("show_log")}>Show log</Button>
          <Button small tone="primary" onClick={() => ask("restart_service")}>Restart service</Button>
        </div>
      ) : null}
    </div>
  );
}
