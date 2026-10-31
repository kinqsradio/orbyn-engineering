import { api } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import { CopyCommand, Pill } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";

export function AccessSection() {
  const info = useAsync("info", (signal) => api.info(signal));
  return (
    <>
      <div className="section-bar">
        <h1 tabIndex={-1} data-page-title>
          Access
        </h1>
      </div>
      {info.status === "loading" ? (
        <Loading label="Loading access state" rows={2} />
      ) : info.status === "error" ? (
        <ErrorState title="Couldn't load access state" failure={info.error} onRetry={info.reload} />
      ) : (
        <>
          <dl className="facts facts-block">
            <div>
              <dt>Mode</dt>
              <dd>
                {info.data.remote ? <Pill tone="warn">Remote</Pill> : <Pill>This computer only</Pill>}
              </dd>
            </div>
            <div>
              <dt>Service version</dt>
              <dd>{info.data.version}</dd>
            </div>
            <div>
              <dt>Platform</dt>
              <dd>{info.data.platform}</dd>
            </div>
          </dl>
          <section className="section">
            <h2>{info.data.remote ? "Remote access is on" : "Turn on remote access"}</h2>
            {info.data.remote ? (
              <p>
                Anyone with the access key and a network path to this service can run engines here.
                Restart without <code>--remote</code> to turn it off.
              </p>
            ) : (
              <>
                <p>
                  Remote mode is set when the service starts, not here. It needs an access key and a
                  secure transport you provide, such as Tailscale, SSH or a TLS proxy.
                </p>
                <CopyCommand command="orbynd --remote --tls-terminated" label="Copy command" />
                <p className="muted">
                  Orbyn doesn't encrypt the connection itself. <code>--tls-terminated</code> states
                  that your transport does.
                </p>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
