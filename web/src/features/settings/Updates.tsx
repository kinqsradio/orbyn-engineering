import { useState } from "react";
import { api } from "../../api/client";
import { fullTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { appHasUpdate, useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { availableCount, UpdateEverythingDialog } from "../workspace/Updates";

export function UpdatesSection() {
  const updates = useWorkspace((state) => state.updates);
  const unsupported = useWorkspace((state) => state.updatesUnsupported);
  const refreshUpdates = useWorkspace((state) => state.refreshUpdates);
  const putUpdates = useWorkspace((state) => state.putUpdates);
  const settings = useAsync("server-settings", (signal) => api.settings(signal));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const status = updates.data;

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      putUpdates(await api.checkUpdates());
    } catch (failure) {
      setError(`Couldn't check for updates. ${toFailure(failure).message}`);
    } finally {
      setChecking(false);
    }
  };

  const heading = (
    <div className="section-bar">
      <h1 tabIndex={-1} data-page-title>
        Updates
      </h1>
      <Button small busy={checking} onClick={() => void check()}>
        Check for updates
      </Button>
    </div>
  );

  if (unsupported) {
    return (
      <>
        {heading}
        <Empty title="Updates aren't set up for this build" />
      </>
    );
  }
  if (updates.error && !status) {
    return (
      <>
        {heading}
        <ErrorState title="Couldn't load updates" failure={updates.error} onRetry={() => void refreshUpdates()} />
      </>
    );
  }
  if (!status) {
    return (
      <>
        {heading}
        <Loading label="Loading updates" rows={2} />
      </>
    );
  }

  const count = availableCount(status);
  return (
    <>
      {heading}
      <dl className="facts facts-block">
        <div>
          <dt>Last checked</dt>
          <dd>{status.checked_at ? fullTime(status.checked_at) : "Not yet"}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>{count === 0 ? "Everything is up to date" : count}</dd>
        </div>
        <div>
          <dt>App</dt>
          <dd>{status.app.unconfigured ? "Updates aren't set up for this build" : status.app.current}</dd>
        </div>
      </dl>
      {status.error ? <p className="banner banner-warn">{status.error}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <label className="check">
        <input
          type="checkbox"
          checked={settings.data?.background_update_checks !== false}
          disabled={!settings.data}
          onChange={(event) => {
            if (!settings.data) return;
            const next = { ...settings.data, background_update_checks: event.target.checked };
            void api.putSettings(next).then(settings.setData, (failure: unknown) => {
              setError(toFailure(failure).message);
            });
          }}
        />
        <span>Check in the background</span>
      </label>
      <p className="muted">Checks only look. Nothing is applied until you click Update.</p>
      {count > 0 || appHasUpdate(status) ? (
        <div className="form-actions">
          <Button tone="primary" small onClick={() => setReviewing(true)}>
            Review updates
          </Button>
        </div>
      ) : null}
      {reviewing ? <UpdateEverythingDialog onClose={() => setReviewing(false)} /> : null}
    </>
  );
}
