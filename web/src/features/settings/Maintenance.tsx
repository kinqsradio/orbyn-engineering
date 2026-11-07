import { settingsLabel } from "./settingsSearch";
import { ChevronRight, Copy, RefreshCw } from "lucide-react";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { useLayoutEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../ui/Dialog";
import { api, request } from "../../api/client";
import type { CleanupReport, Diagnostics, JsonValue, OtlpResult } from "../../api/types";
import type { ServiceProcess } from "../../generated/ServiceProcess";
import { fullTime, sizeWords } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { useUi } from "../../state/ui";
import { ErrorState, Loading } from "../../ui/states";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ScopedPreferencesChange } from "../../generated/ScopedPreferencesChange";
import { useSettingsScope } from "./SettingsScopeContext";
import { Button } from "../../ui/controls";
import { Collapsible } from "../../ui/Collapsible";
import { DialogCard } from "./DialogCard";
import { LibraryChoice } from "./LibraryChoice";
import { SettingsBanner, SettingsEmpty } from "./SettingsBanner";
import { useConnection } from "../../state/connection";
import { FallbackNotice, Library } from "./Projects";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const mib = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`;

const duration = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;

/** Past this, the space a repair gets back is worth a mention. */
const REPAIR_NOTICE_BYTES = 1024 ** 3;

const SIGNALS = [
  { key: "traces_url", title: settingsLabel("maintenance-traces"), signal: "traces" },
  { key: "metrics_url", title: settingsLabel("maintenance-metrics"), signal: "metrics" },
  { key: "logs_url", title: settingsLabel("maintenance-logs"), signal: "logs" },
] as const;
type SignalKey = typeof SIGNALS[number]["key"];
type EndpointCheck = { url: string; message: string; pending: boolean; failed?: boolean };
const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

function TelemetryEnvironmentNotice() {
  const scope = useSettingsScope();
  const info = useAsync("telemetry-environment", (signal) => api.info(signal));
  return <div className="setting-row">
    <p className="setting-line-desc">Choose one environment to configure its telemetry exports.</p>
    {info.error ? <ErrorState title="Couldn't load settings" failure={info.error} onRetry={info.reload} compact /> :
      <Button small tone="quiet" style={{ justifyContent: "space-between" }} disabled={!scope || !info.data} onClick={() => scope?.select(undefined)}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><EnvironmentIcon icon={info.data?.environment_icon} />{info.data?.environment_label ?? "Loading…"}</span>
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
      useUi.getState().bumpPreferencesRevision();
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
    const finish = (text: string, failed: boolean) => {
      if (mounted.current && checkRequests.current.get(key) === id) {
        setChecks((previous) => ({ ...previous, [key]: { url, message: text, pending: false, failed } }));
      }
    };
    request<OtlpResult>("POST", "/api/diagnostics/otlp", { url }).then(
      (result) => result.ok ? finish(`Reached, ${result.status}`, false) : finish("Couldn’t reach this address.", true),
      () => finish("Couldn’t reach this address.", true),
    );
  };
  return <form aria-label="OpenTelemetry export" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="setting-row"><p className="setting-line-desc">Send traces, metrics, and logs to an OTLP HTTP receiver. Restart the server to apply. Environment variables override these settings.</p></div>
    {SIGNALS.map((signal) => {
      const url = value(signal.key);
      const check = checks[signal.key]?.url === url.trim() ? checks[signal.key] : undefined;
      return <SettingRow key={signal.key} title={signal.title} description={check?.message}>
        <input aria-label={`${signal.title} endpoint`} type="url" pattern="[Hh][Tt][Tt][Pp][Ss]?://.*" className="set-endpoint-input" aria-invalid={check?.failed || undefined}
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
  { key: "browser_artifacts_after_days", title: settingsLabel("maintenance-browser-artifacts-days"),
    description: "Screenshots and downloads the Browser panel saved" },
  { key: "logs_after_days", title: settingsLabel("maintenance-logs-days"),
    description: "Log files that are no longer written to" },
] as const;
type RetentionKey = typeof RETENTION[number]["key"];

function CleanupGroup() {
  const scope = useSettingsScope();
  // Storage cleanup has no project/checkout form or fallback writer.
  if (scope?.error || scope?.catalog?.selection.kind !== "all_projects") return null;
  return <EnvironmentCleanup key={JSON.stringify(scope.query)} query={scope.query} disabled={scope.loading} />;
}

export function EnvironmentCleanup({ query, disabled }: { query: ProjectScopesQuery; disabled: boolean }) {
  const preferences = useAsync(JSON.stringify(["storage-cleanup", query]), (signal) =>
    request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: query, keys: ["storage_cleanup", "worktree_cleanup"] }, signal));
  const last = useAsync("cleanup-report", (signal) =>
    request<CleanupReport | null>("GET", "/api/storage/cleanup", undefined, signal));
  const preview = useAsync(JSON.stringify(["cleanup-preview", query]), (signal) => api.storageCleanupPreview(signal));
  const [draft, setDraft] = useState<Partial<Record<RetentionKey, string>>>({});
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (preferences.status === "loading") return <Loading label="Loading settings" rows={2} />;
  if (preferences.status === "error") return <ErrorState title="Couldn't load settings" failure={preferences.error} onRetry={preferences.reload} compact />;
  const snapshot = preferences.data;
  if (snapshot.catalog.selection.kind !== "all_projects") return null;
  const row = snapshot.rows.find((entry) => entry.key === "storage_cleanup");
  if (!row) return null;
  const rules = row.value !== null && typeof row.value === "object" && !Array.isArray(row.value) ? row.value : {};
  const saved = (key: RetentionKey) => typeof rules[key] === "number" ? rules[key] : null;
  const busy = disabled || saving || deleting || preferences.refreshing;
  const save = async (key: RetentionKey, value: number | null) => {
    if (pending.current || busy || value === saved(key)) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    const mutation = { scope: query, membership_version: snapshot.catalog.version,
      if_match: { storage_cleanup: row.revision }, edits: { storage_cleanup: { op: "set", value: { [key]: value } } },
    } satisfies ScopedPreferencesChange;
    try {
      const next = await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", mutation);
      useUi.getState().bumpPreferencesRevision();
      if (mounted.current) {
        preferences.setData({ ...snapshot, catalog: next.catalog,
          rows: snapshot.rows.map((previous) => next.rows.find((entry) => entry.key === previous.key) ?? previous) });
        setDraft((previous) => { const next = { ...previous }; delete next[key]; return next; });
      }
    } catch (failure) {
      if (mounted.current) {
        const problem = toFailure(failure);
        setError(problem.message);
        // Refresh the version without discarding or automatically replaying a draft.
        if (problem.status === 409) preferences.reload();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const commitDays = (key: RetentionKey) => {
    const text = draft[key];
    if (busy || text === undefined) return;
    if (text.trim() === "" && saved(key) !== null) {
      // An empty field turns the rule off.
      void save(key, null);
      return;
    }
    if (text.trim() === "" || !Number.isFinite(Number(text))) {
      setDraft((previous) => { const next = { ...previous }; delete next[key]; return next; });
      return;
    }
    const days = Math.max(1, Math.min(3650, Math.round(Number(text))));
    if (days === saved(key)) {
      setDraft((previous) => { const next = { ...previous }; delete next[key]; return next; });
      return;
    }
    setDraft((previous) => ({ ...previous, [key]: String(days) }));
    void save(key, days);
  };
  const run = async () => {
    if (pending.current || busy) return;
    pending.current = true;
    setDeleting(true);
    setError(null);
    try {
      const result = await request<CleanupReport>("POST", "/api/storage/cleanup");
      if (mounted.current) setReport(result);
    } catch (failure) {
      if (mounted.current) setError(toFailure(failure).message);
    } finally {
      pending.current = false;
      if (mounted.current) setDeleting(false);
    }
  };
  // The environment action also evaluates explicit project worktree policies.
  // Legacy project storage_cleanup objects never participate in that policy.
  const worktrees = snapshot.rows.find((entry) => entry.key === "worktree_cleanup");
  const validAge = (value: JsonValue | undefined): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3650 ? value : null;
  const worktreeAge = (value: JsonValue | undefined, inherited: number | null): number | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return inherited;
    if (value.mode === "off") return null;
    if (value.mode !== "custom") return inherited;
    const own = value.rules;
    return own !== null && typeof own === "object" && !Array.isArray(own) ? validAge(own.settled_after_days) : null;
  };
  const environmentAge = worktreeAge(worktrees?.environment.value, validAge(rules.worktree_settled_after_days));
  const hasRules = RETENTION.some(({ key }) => saved(key) !== null) || environmentAge !== null ||
    worktrees?.overrides.some((entry) => worktreeAge(entry.value, environmentAge) !== null) === true;
  const hasDraft = RETENTION.some(({ key }) => draft[key] !== undefined && draft[key] !== String(saved(key)));
  const shown = report ?? last.data ?? null;
  // The dry run says what each kind would lose and how much room it takes. Held entries are named by the rules but kept.
  const found = (kind: string) => {
    const group = preview.data?.groups.find((entry) => entry.kind === kind);
    const count = group ? Number(group.count) : 0;
    // A worktree too large to measure in full makes its size a floor, shown as "at least"; with no size known, the count stands alone.
    const floor = group !== undefined && kind === "worktree" && preview.data?.partial === true;
    const bytes = group ? Number(group.bytes) : 0;
    return { count, size: group === undefined || (floor && bytes === 0) ? null : floor ? `at least ${sizeWords(bytes)}` : sizeWords(bytes) };
  };
  const counts = { artifact: found("artifact"), log: found("log"), worktree: found("worktree") };
  return <>
    <SettingGroup title="Retention">
      {RETENTION.map((rule) => <SettingRow key={rule.key} title={rule.title} description={rule.description}>
        <span className="unit-field">
          <input aria-label={`${rule.title} in days`} type="number" min="1" max="3650" step="1" disabled={busy} placeholder="Off"
            value={draft[rule.key] ?? (saved(rule.key) === null ? "" : String(saved(rule.key)))}
            onChange={(event) => {
              const text = event.target.value;
              setDraft((previous) => {
                const next = { ...previous, [rule.key]: text };
                if (text === String(saved(rule.key))) delete next[rule.key];
                return next;
              });
            }}
            onBlur={() => commitDays(rule.key)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
          <span className="t3" aria-hidden>days</span>
        </span>
      </SettingRow>)}
    </SettingGroup>
    <SettingGroup>
      <SettingRow title={settingsLabel("maintenance-run-the-rules")} description={!hasRules ? "Turn on a cleanup rule to use this." : previewLine(counts)}>
        <Button small tone="danger" disabled={busy || !hasRules || hasDraft} onClick={() => setConfirming(true)}>{deleting ? "Deleting…" : "Delete now…"}</Button>
      </SettingRow>
      {confirming ? (
        <ConfirmDialog title="Delete old files now?" confirmLabel="Delete now" tone="danger" cancelFocus onClose={() => setConfirming(false)}
          onConfirm={async () => { await run(); preview.reload(); }}>
          <p>They are removed from disk. This can’t be undone.</p>
          <DialogCard facts={[
            ...(saved("browser_artifacts_after_days") !== null ? [{ label: `Browser artifacts older than ${saved("browser_artifacts_after_days")} days`, value: factLine(counts.artifact) }] : []),
            ...(saved("logs_after_days") !== null ? [{ label: `Rotated logs older than ${saved("logs_after_days")} days`, value: factLine(counts.log) }] : []),
            ...(counts.worktree.count > 0 ? [{ label: "Settled worktrees", value: factLine(counts.worktree) }] : []),
          ]} />
        </ConfirmDialog>
      ) : null}
      {shown ? <Collapsible summary="Last run">
        <p className="setting-line-desc">{reportLine(shown)}</p>
        {shown.entries.length > 0 ? <ul className="cleanup-report" aria-label="Cleanup report">
          {shown.entries.map((entry) => <li key={`${entry.kind}:${entry.path}`}>
            <code title={entry.path}>{entry.path.split(/[\\/]/).at(-1)}</code>
            <span>{entry.removed ? "Removed" : "Kept"}: {entry.reason}</span>
          </li>)}
        </ul> : null}
      </Collapsible> : null}
      {last.error ? <ErrorState title="Couldn't load cleanup report" failure={last.error} onRetry={last.reload} compact /> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </SettingGroup>
  </>;
}

type Found = { count: number; size: string | null };
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const factLine = ({ count, size }: Found) => (size ? `${count} · ${size}` : String(count));
/** "Would delete 3 browser artifacts (48 MB) and 1 log (2 MB)": only what the dry run finds. */
const previewLine = (counts: { artifact: Found; log: Found; worktree: Found }) => {
  const part = (found: Found, one: string, many: string) => (found.count > 0 ? `${plural(found.count, one, many)}${found.size ? ` (${found.size})` : ""}` : null);
  const parts = [part(counts.artifact, "browser artifact", "browser artifacts"), part(counts.log, "log", "logs"), part(counts.worktree, "settled worktree", "settled worktrees")]
    .filter((entry): entry is string => entry !== null);
  return parts.length === 0 ? undefined : `Would delete ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}`;
};

const reportLine = (report: CleanupReport) => {
  const removed = report.entries.filter((entry) => entry.removed).length;
  return `${fullTime(report.ran_at)}: ${removed} removed, ${report.entries.length - removed} kept`;
};

/** Sizes as the design writes them: whole megabytes, gigabytes with one decimal. */
const size = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
const DAY_MS = 86_400_000;

/** Today by the clock, yesterday named, anything older by date. */
function problemTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / DAY_MS);
  return days <= 0 ? clock : days === 1 ? `Yesterday ${clock}` : `${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock}`;
}

function DiagnosticsGroup() {
  const info = useAsync("diagnostics", (signal) => request<Diagnostics>("GET", "/api/diagnostics", undefined, signal));
  const offline = useConnection((state) => state.offline);
  const pushToast = useUi((state) => state.pushToast);
  const [note, setNote] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [stopping, setStopping] = useState<ServiceProcess | null>(null);
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
  if (info.status === "loading") return <SettingGroup title="Diagnostics"><Loading label="Loading diagnostics" rows={4} /></SettingGroup>;
  const data = info.data;
  if (!data) return <SettingGroup title="Diagnostics">
    <SettingsBanner tone="err">Can’t reach the Orbyn service, so there is nothing to show.</SettingsBanner>
  </SettingGroup>;
  const stoppable = data.processes.filter((process) => process.pid !== data.pid);
  const recent = data.events.filter((event) => Date.now() - Date.parse(event.at) <= DAY_MS);
  const memory = data.history.at(-1)?.memory_bytes;
  const facts: [string, string][] = [
    ["Service", `Running · ${data.version}`],
    ["Active", `${data.active_runs} ${data.active_runs === 1 ? "thread" : "threads"} running`],
    ["Database", size(data.database.bytes)],
    ...(memory === undefined ? [] : [["Memory", size(memory)] as [string, string]]),
  ];
  const copy = () => {
    const lines = [...facts.map(([label, value]) => `${label}: ${value}`),
      ...recent.map((event) => `${problemTime(event.at)} ${event.message}`)];
    void navigator.clipboard?.writeText(lines.join("\n")).then(() => pushToast("Report copied"), () => undefined);
  };
  return (
    <SettingGroup title="Diagnostics">
      {offline ? <SettingsBanner>You’re offline. These figures are from this computer and are still current.</SettingsBanner> : null}
      <div className="set-facts" role="group" aria-label="Service">
        <div className="set-facts-head"><b>Orbyn service</b><Button small tone="quiet" icon={<Copy size={14} aria-hidden />} onClick={copy}>Copy report</Button></div>
        {facts.map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
        <div className="set-facts-foot"><Button small onClick={() => setRepairing(true)}>Repair database</Button></div>
      </div>
      {repairing ? <ConfirmDialog title="Repair the database?" confirmLabel="Repair database" cancelFocus onClose={() => setRepairing(false)}
        onConfirm={async () => { await run("/api/diagnostics/repair", "Database repaired"); }}>
        <p>Orbyn will check and repair its local database. Threads aren’t deleted.</p>
      </ConfirmDialog> : null}
      {recent.length === 0 ? <SettingsEmpty title="No problems">Nothing went wrong in the last 24 hours.</SettingsEmpty> : <>
        <SettingRow title="Recent problems" description={`${recent.length} in the last 24 hours`}>
          <Button small aria-expanded={showProblems} onClick={() => setShowProblems(!showProblems)}>{showProblems ? "Hide" : "Show"}</Button>
        </SettingRow>
        {showProblems ? <div className="set-tbl" role="table" aria-label="Recent problems">
          {recent.map((event, at) => <div key={at} role="row" className="set-tr" style={{ gridTemplateColumns: "90px minmax(0, 1fr)" }}>
            <span role="cell" className="set-time">{problemTime(event.at)}</span><span role="cell">{event.message}</span>
          </div>)}
        </div> : null}
      </>}
      <p className="set-grp">Processes</p>
      {stoppable.length === 0 ? <p className="setting-line-desc">No running processes.</p> : <ul className="setting-list" aria-label="Processes">
        {stoppable.map((process) => (
          <li key={process.pid}>
            <SettingRow title={process.name} description={`Running ${duration(process.running_seconds)}`}>
              <button type="button" className="set-red-link" aria-label={`Stop ${process.name}`} onClick={() => setStopping(process)}>Stop</button>
            </SettingRow>
          </li>
        ))}
      </ul>}
      {stopping ? <ConfirmDialog title={`Stop ${stopping.name}?`} confirmLabel="Stop" tone="danger" cancelFocus onClose={() => setStopping(null)}
        onConfirm={async () => { await run(`/api/diagnostics/processes/${stopping.pid}/stop`, `Stopped ${stopping.name}`); }}>
        <p>It stops now. Threads that use it end their current turn.</p>
      </ConfirmDialog> : null}
      {note ? <SettingRow title="Last action" description={note} /> : null}
      {data.database.reclaimable_bytes >= REPAIR_NOTICE_BYTES ? (
        <p className="banner banner-warn" role="status">
          The database can give back {mib(data.database.reclaimable_bytes)}. Repair it when no run is active.
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
  const offline = useConnection((state) => state.offline);
  const failure = error ?? updates?.error ?? null;
  const app = updates?.app;
  // The shell reports bytes while it downloads; the update is ready once all of them are in.
  const hasProgress = !!app?.latest && app.downloaded !== undefined && app.total !== undefined && Number(app.total) > 0;
  const percent = hasProgress ? Math.min(100, Math.floor((Number(app?.downloaded) / Number(app?.total)) * 100)) : 0;
  const downloading = hasProgress && percent < 100;
  const ready = hasProgress && !downloading && !!app?.can_apply;
  const restart = async () => {
    try { await api.applyAppUpdate(); } catch (problem) { setError(toFailure(problem).message); }
  };

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      putUpdates(await api.checkUpdates());
    } catch (problem) {
      setError(toFailure(problem).message);
    } finally {
      setChecking(false);
    }
  };

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
      <SettingGroup title="App updates">
        {unsupported || updates?.app.unconfigured ? (
          <SettingRow title="App updates" description="Updates aren't set up for this build." />
        ) : null}
        {offline ? <SettingsBanner>You’re offline. Updates are checked when you’re back.</SettingsBanner> : null}
        {failure ? <SettingsBanner tone="err" actions={<Button small icon={<RefreshCw size={14} aria-hidden />} disabled={checking} onClick={() => void check()}>Retry</Button>}>
          Couldn’t check for updates. {failure}
        </SettingsBanner> : null}
        <SettingRow title="Version" settingId="maintenance-check-for-updates"
          description={ready && updates?.app.latest ? `${updates.app.current} · ${updates.app.latest} is downloaded`
            : `${updates?.app.current ?? "Unknown"}${checking ? "" : ` · ${updates?.checked_at ? `checked ${new Date(updates.checked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : "not checked yet"}`}`}>
          {checking ? <span className="set-checking" role="status"><i className="spin" aria-hidden />Checking…</span>
            : downloading ? <span className="set-checking" role="status">Downloading {app?.latest}…
              <span className="set-prog" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></span>
              <span className="set-pct">{percent}%</span></span>
            : ready ? <Button tone="primary" small onClick={() => void restart()}>Restart to update</Button>
            : <Button small disabled={offline} onClick={() => void check()}>Check for updates</Button>}
        </SettingRow>
        <SettingRow title={settingsLabel("maintenance-background-checks")} description="Look for updates while the app runs">
          <input
            type="checkbox"
            role="switch"
            aria-label="Background checks"
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
    </>
  );
}
