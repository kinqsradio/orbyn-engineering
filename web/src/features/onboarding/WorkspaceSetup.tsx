import { Loader2 } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import type { WorkspaceSetup as SetupChoice } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { OrbynMark } from "../../ui/badges";
import { Button } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { FolderBrowser } from "./FolderBrowser";

function Setup() {
  const putManaged = useWorkspace((state) => state.putManaged);
  const group = useId();
  const [mode, setMode] = useState<"managed" | "adopt">("managed");
  const [last, setLast] = useState<SetupChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async (choice: SetupChoice) => {
    setBusy(true);
    setError(null);
    setLast(choice);
    try {
      putManaged(await api.setupWorkspace(choice));
    } catch (cause) {
      setError(toFailure(cause).message);
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
        {busy ? (
          <p className="setup-progress" role="status">
            <Loader2 size={16} className="spin" aria-hidden />
            {last?.adopt_path ? "Checking the library folder" : "Cloning the skill library"}
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
                  <span>Uses a skill library folder you already have. It stays where it is.</span>
                </span>
              </label>
            </fieldset>
            {error ? (
              <div className="error-state" role="alert">
                <div className="error-text">
                  <strong>Setup didn't finish</strong>
                  <span>{error}</span>
                </div>
                {last ? (
                  <Button small onClick={() => void start(last)}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
            {mode === "managed" ? (
              <div className="form-actions">
                <Button tone="primary" onClick={() => void start({})}>
                  Set up workspace
                </Button>
              </div>
            ) : (
              <FolderBrowser actionLabel="Adopt this folder" onChoose={(path) => void start({ adopt_path: path })} />
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

  if (unsupported || managed.data?.configured) return children;
  if (managed.data) return <Setup />;
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
