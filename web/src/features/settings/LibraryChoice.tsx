import { useState } from "react";
import { api } from "../../api/client";
import type { WorkspaceSetup } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { FolderBrowser } from "../onboarding/FolderBrowser";
import { Advanced } from "./PreferenceRows";

/** A way back when skills are unavailable, and the choice of a library of your own. */
export function LibraryChoice() {
  const status = useWorkspace((state) => state.managed.data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (choice: WorkspaceSetup) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setupWorkspace(choice);
      const { putManaged, refreshAll, refreshEngines } = useWorkspace.getState();
      putManaged(next);
      await Promise.all([refreshAll(), refreshEngines()]);
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  return (
    <>
      {status.configured ? null : (
        <SettingGroup title="Skill library">
          <SettingRow title="Skills aren't available right now" description="Try again, or use a library of your own under Advanced.">
            <Button small busy={busy} onClick={() => void choose({})}>
              Try again
            </Button>
          </SettingRow>
        </SettingGroup>
      )}
      <Advanced>
        <h3>Use another skill library</h3>
        <FolderBrowser actionLabel="Use this folder" busy={busy} onChoose={(path) => void choose({ adopt_path: path })} />
      </Advanced>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
