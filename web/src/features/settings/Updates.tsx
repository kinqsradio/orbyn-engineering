import { useState } from "react";
import { api } from "../../api/client";
import { fullTime } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { availableCount, UpdateEverythingDialog } from "../workspace/Updates";

export function UpdatesSection() {
  const updates = useWorkspace((state) => state.updates);
  const unsupported = useWorkspace((state) => state.updatesUnsupported);
  const refreshUpdates = useWorkspace((state) => state.refreshUpdates);
  const putUpdates = useWorkspace((state) => state.putUpdates);
  const background = useUi((state) => state.backgroundChecks);
  const setBackground = useUi((state) => state.setBackgroundChecks);
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
      {status?.configured ? (
        <Button small busy={checking} onClick={() => void check()}>
          Check for updates
        </Button>
      ) : null}
    </div>
  );

  if (unsupported || status?.configured === false) {
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
      </dl>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <label className="check">
        <input
          type="checkbox"
          checked={background}
          onChange={(event) => setBackground(event.target.checked)}
        />
        <span>Check in the background</span>
      </label>
      <p className="muted">Checks only look. Nothing is applied until you click Update.</p>
      {count > 0 || status.app?.available ? (
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
