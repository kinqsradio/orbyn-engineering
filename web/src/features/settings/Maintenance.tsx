import { useState } from "react";
import { api, request } from "../../api/client";
import type { Diagnostics } from "../../api/types";
import { fullTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { FallbackNotice, Library } from "./Projects";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const mib = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`;

function DiagnosticsGroup() {
  const info = useAsync("diagnostics", (signal) => request<Diagnostics>("GET", "/api/diagnostics", undefined, signal));
  const [note, setNote] = useState<string | null>(null);
  const run = async (path: string, done: string) => {
    setNote(null);
    try {
      await request("POST", path);
      setNote(done);
      info.reload();
    } catch (failure) {
      setNote(toFailure(failure).message);
    }
  };
  if (!info.data) return null;
  return (
    <SettingGroup title="Diagnostics">
      <SettingRow title="Service" description={`Version ${info.data.version}, process ${info.data.pid}`} />
      <SettingRow
        title="Active"
        description={`${info.data.active_runs} runs, ${info.data.terminals} terminals`}
      />
      <SettingRow
        title="Database"
        description={`${mib(info.data.database.bytes)}, ${mib(info.data.database.reclaimable_bytes)} reclaimable`}
      >
        <Button small onClick={() => void run("/api/diagnostics/repair", "Database repaired")}>
          Repair
        </Button>
      </SettingRow>
      <SettingRow title="Storage" description={note ?? "Removes old attachments and logs under the retention rules."}>
        <Button small onClick={() => void run("/api/storage/cleanup", "Cleaned up")}>
          Clean up
        </Button>
      </SettingRow>
    </SettingGroup>
  );
}

export function MaintenanceSection() {
  const updates = useWorkspace((state) => state.updates.data);
  const library = useWorkspace((state) => state.managed.data?.library);
  const unsupported = useWorkspace((state) => state.updatesUnsupported);
  const putUpdates = useWorkspace((state) => state.putUpdates);
  const settings = useAsync("server-settings", (signal) => api.settings(signal));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const lastChecked = updates?.checked_at ? fullTime(updates.checked_at) : "Not checked yet";
  return (
    <>
      <h1 className="sr-only" tabIndex={-1} data-page-title>
        Maintenance
      </h1>
      <DiagnosticsGroup />
      {library?.native_skills === false ? <FallbackNotice /> : null}
      {library ? <Library library={library} /> : null}
      <SettingGroup title="Updates">
        {unsupported || updates?.app.unconfigured ? (
          <SettingRow title="App updates" description="Updates aren't set up for this build." />
        ) : null}
        <SettingRow title="Check for updates" description={`Last checked: ${lastChecked}`}>
          <Button small busy={checking} onClick={() => void check()}>
            Check for updates
          </Button>
        </SettingRow>
        <SettingRow title="Background checks" description="Checks only look. Nothing is applied without a click.">
          <input
            type="checkbox"
            aria-label="Check in the background"
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
        </SettingRow>
      </SettingGroup>
      {updates?.error ? <p className="banner banner-warn">{updates.error}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
