import { settingsLabel } from "./settingsSearch";
import { ChevronRight, Monitor } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { api, request } from "../../api/client";
import type { CleanupReport, Diagnostics, JsonValue, OtlpResult, PreferenceView } from "../../api/types";
import type { ResourceSample } from "../../generated/ResourceSample";
import { fullTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { useUi } from "../../state/ui";
import { ErrorState, Loading } from "../../ui/states";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ScopedPreferencesChange } from "../../generated/ScopedPreferencesChange";
import { useSettingsScope } from "./SettingsScopeContext";
import { Button } from "../../ui/controls";
import { LibraryChoice } from "./LibraryChoice";
import { FallbackNotice, Library } from "./Projects";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const mib = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`;

const duration = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;

const memoryLine = (history: ResourceSample[]) => {
  const peak = Math.max(...history.map((sample) => sample.memory_bytes));
  const now = history.at(-1)?.memory_bytes ?? 0;
  return `${mib(now)} now, ${mib(peak)} at most over the last ${history.length === 1 ? "minute" : `${history.length} minutes`}`;
};

/** Past this, the space a repair gets back is worth a mention. */
const REPAIR_NOTICE_BYTES = 1024 ** 3;

const SIGNALS = [
  { key: "traces_url", title: settingsLabel("maintenance-traces"), signal: "traces" },
  { key: "metrics_url", title: settingsLabel("maintenance-metrics"), signal: "metrics" },
  { key: "logs_url", title: settingsLabel("maintenance-logs"), signal: "logs" },
] as const;
type SignalKey = typeof SIGNALS[number]["key"];
type EndpointCheck = { url: string; message: string; pending: boolean };
const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

function TelemetryEnvironmentNotice() {
  const scope = useSettingsScope();
  const info = useAsync("telemetry-environment", (signal) => api.info(signal));
  return <div className="setting-row">
    <p className="setting-line-desc">Choose one environment to configure its telemetry exports.</p>
    {info.error ? <ErrorState title="Couldn't load settings" failure={info.error} onRetry={info.reload} compact /> :
      <Button small tone="quiet" style={{ justifyContent: "space-between" }} disabled={!scope || !info.data} onClick={() => scope?.select(undefined)}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Monitor size={14} aria-hidden />{info.data?.environment_label ?? "Loading…"}</span>
        <ChevronRight size={14} aria-hidden />
      </Button>}
  </div>;
}

function TelemetryGroup() {
  const scope = useSettingsScope();
  return <SettingGroup title="OpenTelemetry export">
    {scope?.error ? <ErrorState title="Couldn't load settings" failure={scope.error} onRetry={scope.reload} compact /> :
      !scope?.catalog && scope?.loading ? <Loading label="Loading settings" rows={3} /> :
      scope?.catalog?.selection.kind === "all_projects" ?
        <TelemetryForm key={JSON.stringify(scope.query)} query={scope.query} disabled={scope.loading} /> :
        <TelemetryEnvironmentNotice />}
  </SettingGroup>;
}

function endpointValue(value: JsonValue | undefined, key: SignalKey): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const url = value[key];
  return typeof url === "string" ? url : "";
}

/** One local environment snapshot owns these drafts and every later response. */
function TelemetryForm({ query, disabled }: { query: ProjectScopesQuery; disabled: boolean }) {
  const preferences = useAsync(JSON.stringify(["observability", query]), (signal) =>
    request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: query, keys: ["observability"] }, signal));
  const pushToast = useUi((state) => state.pushToast);
  const [draft, setDraft] = useState<Partial<Record<SignalKey, string>>>({});
  const [checks, setChecks] = useState<Partial<Record<SignalKey, EndpointCheck>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const checkRequests = useRef(new Map<SignalKey, number>());
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (preferences.status === "loading") return <Loading label="Loading settings" rows={3} />;
  if (preferences.status === "error") return <ErrorState title="Couldn't load settings" failure={preferences.error} onRetry={preferences.reload} compact />;
  const snapshot = preferences.data;
  if (snapshot.catalog.selection.kind !== "all_projects") return <TelemetryEnvironmentNotice />;
  const row = snapshot.rows.find((entry) => entry.key === "observability");
  if (!row) return null;
  const saved = (key: SignalKey) => endpointValue(row.value, key);
  const value = (key: SignalKey) => draft[key] ?? saved(key);
  const changed = SIGNALS.filter(({ key }) => draft[key] !== undefined && value(key).trim() !== saved(key));
  const busy = disabled || saving || preferences.refreshing;
  const save = async () => {
    if (pending.current || busy || changed.length === 0) return;
    pending.current = true;
    setSaving(true);
    setMessage(null);
    const patch: Record<string, JsonValue> = {};
    for (const { key } of changed) patch[key] = value(key).trim();
    const mutation = {
      scope: query, membership_version: snapshot.catalog.version,
      if_match: { observability: row.revision }, edits: { observability: { op: "set", value: patch } },
    } satisfies ScopedPreferencesChange;
    try {
      const next = await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", mutation);
      if (mounted.current) {
        preferences.setData(next);
        setDraft({});
        setMessage("Saved. Restart the server to apply.");
      }
    } catch (error) {
      if (mounted.current) {
        const failure = toFailure(error);
        pushToast(failure.message);
        // Reconcile the read, not the write: the person's draft requires Save again.
        if (failure.status === 409) preferences.reload();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const test = (key: SignalKey) => {
    const url = value(key).trim();
    if (busy || !isHttpUrl(url)) return;
    const id = (checkRequests.current.get(key) ?? 0) + 1;
    checkRequests.current.set(key, id);
    setChecks((previous) => ({ ...previous, [key]: { url, message: "Checking…", pending: true } }));
    const finish = (text: string) => {
      if (mounted.current && checkRequests.current.get(key) === id) {
        setChecks((previous) => ({ ...previous, [key]: { url, message: text, pending: false } }));
      }
    };
    request<OtlpResult>("POST", "/api/diagnostics/otlp", { url }).then(
      (result) => finish(result.ok ? `Reached, ${result.status}` : (result.message ?? `The server answered ${result.status}`)),
      (failure: unknown) => finish(toFailure(failure).message),
    );
  };
  return <form aria-label="OpenTelemetry export" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="setting-row"><p className="setting-line-desc">Send traces, metrics, and logs to an OTLP HTTP receiver. Restart the server to apply. Environment variables override these settings.</p></div>
    {SIGNALS.map((signal) => {
      const url = value(signal.key);
      const check = checks[signal.key]?.url === url.trim() ? checks[signal.key] : undefined;
      return <SettingRow key={signal.key} title={signal.title} description={check?.message ?? "An OTLP HTTP address."}>
        <input aria-label={`${signal.title} endpoint`} type="url" pattern="[Hh][Tt][Tt][Pp][Ss]?://.*"
          title="Enter an HTTP or HTTPS endpoint, or leave empty to disable export."
          placeholder={`http://localhost:4318/v1/${signal.signal}`} value={url} disabled={busy}
          onChange={(event) => {
            const text = event.target.value;
            setDraft((previous) => {
              const next = { ...previous, [signal.key]: text };
              if (text.trim() === saved(signal.key)) delete next[signal.key];
              return next;
            });
            setMessage(null);
          }} />
        <Button small type="button" disabled={busy || !isHttpUrl(url.trim()) || check?.pending === true} onClick={() => test(signal.key)}>Test</Button>
      </SettingRow>;
    })}
    <div className="setting-line">
      <p className="setting-line-desc" role="status">{message}</p>
      <div className="form-actions">
      <Button small type="button" disabled={busy || changed.length === 0} onClick={() => { setDraft({}); setMessage(null); }}>Discard</Button>
      <Button small type="submit" disabled={busy || changed.length === 0}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  </form>;
}

const RETENTION = [
  { key: "worktree_settled_after_days", title: settingsLabel("maintenance-worktrees-days-after-settling") },
  { key: "browser_artifacts_after_days", title: settingsLabel("maintenance-browser-artifacts-days") },
  { key: "logs_after_days", title: settingsLabel("maintenance-logs-days") },
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
      <SettingRow title={settingsLabel("maintenance-run-the-rules")} description={shown ? reportLine(shown) : "Nothing is removed by a preview."}>
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
        title={settingsLabel("maintenance-database")}
        description={`${mib(info.data.database.bytes)}, ${mib(info.data.database.reclaimable_bytes)} reclaimable`}
      >
        <Button small onClick={() => void run("/api/diagnostics/repair", "Database repaired")}>
          Repair
        </Button>
      </SettingRow>
      {info.data.history.length > 0 ? <SettingRow title="Memory" description={memoryLine(info.data.history)} /> : null}
      <ul className="setting-list" aria-label="Processes">
        {info.data.processes.map((process) => (
          <li key={process.pid}>
            <SettingRow
              title={process.name}
              description={`Process ${process.pid}, ${mib(process.memory_bytes)}, running ${duration(process.running_seconds)}`}
            >
              {process.pid === info.data?.pid ? null : (
                <Button
                  small
                  onClick={() => void run(`/api/diagnostics/processes/${process.pid}/stop`, `Stopped ${process.name}`)}
                >
                  Stop
                </Button>
              )}
            </SettingRow>
          </li>
        ))}
      </ul>
      {info.data.events.length > 0 ? (
        <ul className="setting-list" aria-label="Recent problems">
          {info.data.events.map((event, at) => (
            <li key={at}>
              <SettingRow title={event.message} description={`${fullTime(event.at)}, ${event.level.toLowerCase()} from ${event.target}`} />
            </li>
          ))}
        </ul>
      ) : (
        <SettingRow title="Recent problems" description="None since the service started." />
      )}
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
      <LibraryChoice />
      <SettingGroup title="Updates">
        {unsupported || updates?.app.unconfigured ? (
          <SettingRow title="App updates" description="Updates aren't set up for this build." />
        ) : null}
        <SettingRow title={settingsLabel("maintenance-check-for-updates")} description={`Last checked: ${lastChecked}`}>
          <Button small busy={checking} onClick={() => void check()}>
            Check for updates
          </Button>
        </SettingRow>
        <SettingRow title={settingsLabel("maintenance-background-checks")} description="Checks only look. Nothing is applied without a click.">
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
