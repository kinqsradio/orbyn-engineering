import { useState } from "react";
import { api, request } from "../../api/client";
import type { CleanupReport, Diagnostics, OtlpResult, PreferenceView } from "../../api/types";
import { fullTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { FallbackNotice, Library } from "./Projects";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const mib = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`;

/** Past this, the space a repair gets back is worth a mention. */
const REPAIR_NOTICE_BYTES = 1024 ** 3;

const SIGNALS = [
  { key: "traces_url", title: "Traces" },
  { key: "metrics_url", title: "Metrics" },
  { key: "logs_url", title: "Logs" },
];

function TelemetryGroup() {
  const preferences = useAsync("observability", (signal) =>
    request<PreferenceView[]>("GET", "/api/preferences", undefined, signal),
  );
  const [results, setResults] = useState<Record<string, string>>({});
  const saved = (preferences.data?.find((entry) => entry.key === "observability")?.value ?? {}) as Record<string, string>;
  if (!preferences.data) return null;
  const save = (key: string, url: string) => {
    if ((saved[key] ?? "") === url) return;
    const next = { ...saved, [key]: url };
    request<PreferenceView[]>("PUT", "/api/preferences", { values: { observability: next } }).then(
      preferences.setData,
      (failure: unknown) => setResults({ ...results, [key]: toFailure(failure).message }),
    );
  };
  const test = (key: string) => {
    request<OtlpResult>("POST", "/api/diagnostics/otlp", { url: saved[key] ?? "" }).then(
      (result) =>
        setResults({
          ...results,
          [key]: result.ok ? `Reached, ${result.status}` : (result.message ?? `The server answered ${result.status}`),
        }),
      (failure: unknown) => setResults({ ...results, [key]: toFailure(failure).message }),
    );
  };
  return (
    <SettingGroup title="OpenTelemetry export">
      {SIGNALS.map((signal) => (
        <SettingRow key={signal.key} title={signal.title} description={results[signal.key] ?? "An OTLP HTTP address."}>
          <input
            aria-label={`${signal.title} address`}
            type="url"
            defaultValue={saved[signal.key] ?? ""}
            onBlur={(event) => save(signal.key, event.target.value.trim())}
          />
          <Button small disabled={!saved[signal.key]} onClick={() => test(signal.key)}>
            Test
          </Button>
        </SettingRow>
      ))}
    </SettingGroup>
  );
}

const RETENTION = [
  { key: "worktree_settled_after_days", title: "Worktrees, days after settling" },
  { key: "browser_artifacts_after_days", title: "Browser artifacts, days" },
  { key: "logs_after_days", title: "Logs, days" },
];

function CleanupGroup() {
  const preferences = useAsync("storage-cleanup", (signal) =>
    request<PreferenceView[]>("GET", "/api/preferences", undefined, signal),
  );
  const last = useAsync("cleanup-report", (signal) =>
    request<CleanupReport | null>("GET", "/api/storage/cleanup", undefined, signal),
  );
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rules = (preferences.data?.find((entry) => entry.key === "storage_cleanup")?.value ?? {}) as Record<string, number>;
  if (!preferences.data) return null;
  const save = (key: string, text: string) => {
    const { [key]: _dropped, ...rest } = rules;
    const next = text ? { ...rest, [key]: Number(text) } : rest;
    request<PreferenceView[]>("PUT", "/api/preferences", { values: { storage_cleanup: next } }).then(
      preferences.setData,
      (failure: unknown) => setError(toFailure(failure).message),
    );
  };
  const run = (dryRun: boolean) => {
    setError(null);
    request<CleanupReport>("POST", `/api/storage/cleanup${dryRun ? "?dry_run=true" : ""}`).then(
      setReport,
      (failure: unknown) => setError(toFailure(failure).message),
    );
  };
  const shown = report ?? last.data ?? null;
  return (
    <SettingGroup title="Storage cleanup">
      {RETENTION.map((rule) => (
        <SettingRow key={rule.key} title={rule.title} description="Empty keeps them.">
          <input
            aria-label={rule.title}
            type="number"
            min="1"
            defaultValue={rules[rule.key] ?? ""}
            onBlur={(event) => {
              if (event.target.value !== String(rules[rule.key] ?? "")) save(rule.key, event.target.value);
            }}
          />
        </SettingRow>
      ))}
      <SettingRow title="Run the rules" description={shown ? reportLine(shown) : "Nothing is removed by a preview."}>
        <Button small onClick={() => run(true)}>
          Preview
        </Button>
        <Button small onClick={() => run(false)}>
          Clean up
        </Button>
      </SettingRow>
      {shown && shown.entries.length > 0 ? (
        <ul className="cleanup-report" aria-label="Cleanup report">
          {shown.entries.map((entry) => (
            <li key={`${entry.kind}:${entry.path}`}>
              <code title={entry.path}>{entry.path.split(/[\\/]/).at(-1)}</code>
              <span>
                {entry.removed ? "Removed" : shown.dry_run ? "Would remove" : "Kept"}: {entry.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingGroup>
  );
}

const reportLine = (report: CleanupReport) => {
  const count = report.entries.length;
  const what = count === 0 ? "Nothing to remove" : `${count} ${count === 1 ? "item" : "items"}`;
  return `${report.dry_run ? "Preview" : "Last run"} ${fullTime(report.ran_at)}: ${what}`;
};

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
      {note ? <SettingRow title="Last action" description={note} /> : null}
      {info.data.database.reclaimable_bytes >= REPAIR_NOTICE_BYTES ? (
        <p className="banner banner-warn" role="status">
          The database can give back {mib(info.data.database.reclaimable_bytes)}. Repair it when no run is active.
        </p>
      ) : null}
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
      <CleanupGroup />
      <TelemetryGroup />
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
