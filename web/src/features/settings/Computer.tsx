import { CircleCheck, CircleSlash } from "lucide-react";
import { api } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import { Pill } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";

function Capability({
  title,
  ready,
  path,
  version,
  needs,
}: {
  title: string;
  ready: boolean;
  path: string | null;
  version?: string | null;
  needs: string;
}) {
  return (
    <li className="setting-row">
      <div className="engine-row-head">
        <h3>{title}</h3>
        {ready ? (
          <Pill>
            <CircleCheck size={16} aria-hidden />
            Available
          </Pill>
        ) : (
          <Pill tone="warn">
            <CircleSlash size={16} aria-hidden />
            Unavailable
          </Pill>
        )}
      </div>
      {path ? (
        <dl className="facts">
          <div>
            <dt>Location</dt>
            <dd>
              <code>{path}</code>
            </dd>
          </div>
          {version ? (
            <div>
              <dt>Version</dt>
              <dd>{version}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <p className="muted">{needs}</p>
    </li>
  );
}

export function ComputerSection() {
  const status = useAsync("computer", (signal) => api.computer(signal));
  return (
    <>
      <div className="section-bar">
        <h1 tabIndex={-1} data-page-title>
          Computer
        </h1>
      </div>
      <p className="lede">Governed tools let an engine operate this machine. Each action goes through Policy.</p>
      {status.status === "loading" ? (
        <Loading label="Loading computer status" rows={2} />
      ) : status.status === "error" ? (
        <ErrorState title="Couldn't load computer status" failure={status.error} onRetry={status.reload} />
      ) : (
        <>
          {status.data.problem ? <p className="banner banner-warn">{status.data.problem}</p> : null}
          <ul className="setting-list">
            <Capability
              title="Desktop control"
              ready={status.data.desktop_control}
              path={status.data.desktop_path}
              version={status.data.desktop_version}
              needs="Needs the desktop control helper, plus Accessibility and Screen Recording permission for it."
            />
            <Capability
              title="Browser control"
              ready={status.data.browser_control}
              path={status.data.browser_path}
              needs="Needs a Chromium-based browser installed on this machine."
            />
          </ul>
        </>
      )}
    </>
  );
}
