import { Loader2 } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import type { WorkspaceSetup as SetupChoice, WorkspaceStatus } from "../../api/workspace";
import { toFailure } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { OrbynMark } from "../../ui/badges";
import { Button } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { FolderBrowser } from "./FolderBrowser";

const POLL_MS = 1000;

function Setup({ status }: { status: WorkspaceStatus }) {
  const putManaged = useWorkspace((state) => state.putManaged);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  const group = useId();
  const [mode, setMode] = useState<SetupChoice["mode"]>("managed");
  const [last, setLast] = useState<SetupChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = status.state === "setting_up";
  const failure = error ?? (status.state === "failed" ? (status.error ?? "Setup stopped.") : null);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refreshManaged(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, refreshManaged]);

  const start = async (choice: SetupChoice) => {
    setBusy(true);
    setError(null);
    setLast(choice);
    try {
      putManaged(await api.setupWorkspace(choice));
    } catch (cause) {
      setError(toFailure(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="setup">
      <div className="setup-card">
        <span className="brand">
          <OrbynMark />
          Orbyn Engineering
        </span>
        <h1 tabIndex={-1} data-page-title>
          Set up your workspace
        </h1>
        <p className="lede">Orbyn keeps your skill library and project checkouts in one managed place.</p>
        {running ? (
          <p className="setup-progress" role="status">
            <Loader2 size={16} className="spin" aria-hidden />
            {status.step ?? "Setting up"}
          </p>
        ) : (
          <>
            <fieldset className="choice-list">
              <legend className="sr-only">Skill library</legend>
              <label className="choice">
                <input type="radio" name={group} checked={mode === "managed"} onChange={() => setMode("managed")} />
                <span className="choice-text">
                  <strong>Set up managed workspace</strong>
                  <span>Clones the skill library and keeps it up to date from Settings.</span>
                </span>
              </label>
              <label className="choice">
                <input type="radio" name={group} checked={mode === "adopt"} onChange={() => setMode("adopt")} />
                <span className="choice-text">
                  <strong>Adopt an existing library</strong>
                  <span>Uses a skill library folder you already have.</span>
                </span>
              </label>
            </fieldset>
            {failure ? (
              <div className="error-state" role="alert">
                <div className="error-text">
                  <strong>Setup didn't finish</strong>
                  <span>{failure}</span>
                </div>
                {last ? (
                  <Button small busy={busy} onClick={() => void start(last)}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
            {mode === "managed" ? (
              <div className="form-actions">
                <Button tone="primary" busy={busy} onClick={() => void start({ mode: "managed" })}>
                  Set up workspace
                </Button>
              </div>
            ) : (
              <FolderBrowser
                actionLabel="Adopt this folder"
                busy={busy}
                onChoose={(path) => void start({ mode: "adopt", path })}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** Nothing else opens until the workspace exists. */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const managed = useWorkspace((state) => state.managed);
  const unsupported = useWorkspace((state) => state.managedUnsupported);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);

  useEffect(() => {
    void refreshManaged();
  }, [refreshManaged]);

  if (unsupported || managed.data?.state === "ready") return children;
  if (managed.data) return <Setup status={managed.data} />;
  return (
    <main className="boot">
      {managed.error ? (
        <ErrorState title="Couldn't load the workspace" failure={managed.error} onRetry={() => void refreshManaged()} />
      ) : (
        <Loading label="Loading workspace" rows={3} />
      )}
    </main>
  );
}
