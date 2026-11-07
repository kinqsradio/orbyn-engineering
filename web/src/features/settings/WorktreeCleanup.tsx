import { useEffect, useRef, useState } from "react";
import { request } from "../../api/client";
import type { JsonValue } from "../../api/types";
import type { PreferenceEdit } from "../../generated/PreferenceEdit";
import type { ProjectScopeGroup } from "../../generated/ProjectScopeGroup";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ScopedPreferenceRow } from "../../generated/ScopedPreferenceRow";
import { toFailure, useAsync } from "../../lib/useAsync";
import { Button } from "../../ui/controls";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { ErrorState, Loading } from "../../ui/states";
import { PreferenceInheritance } from "./PreferenceRows";
import { useSettingsScope } from "./SettingsScopeContext";
import { useUi } from "../../state/ui";

/** Turning cleanup on without a number of days uses this one. */
const DEFAULT_DAYS = 7;
const TITLE = "Automatic worktree cleanup";

type Policy = { mode?: string; rules?: { settled_after_days?: unknown } };
const policy = (value: unknown): Policy => value !== null && typeof value === "object" ? value as Policy : {};

/** Off or On, with the days a worktree stays after it settles (7 until set) beside it while On. */
function CleanupSelect({ label, current, disabled, mixed, set }: { label: string; current: number | null; disabled: boolean; mixed?: boolean; set(days: number | null): void }) {
  const [draft, setDraft] = useState(String(current ?? DEFAULT_DAYS));
  useEffect(() => { setDraft(String(current ?? DEFAULT_DAYS)); }, [current]);
  const commit = () => {
    if (current === null || draft.trim() === "" || !Number.isFinite(Number(draft))) { setDraft(String(current ?? DEFAULT_DAYS)); return; }
    const next = Math.max(0, Math.min(3650, Math.round(Number(draft))));
    setDraft(String(next));
    if (next !== current) set(next);
  };
  return <span className="set-inline-control">
    <select aria-label={label} disabled={disabled} value={mixed ? "mixed" : current === null ? "off" : "on"}
      onChange={(event) => set(event.target.value === "on" ? Number(draft) || DEFAULT_DAYS : null)}>
      {mixed ? <option value="mixed" disabled>Mixed</option> : null}
      <option value="off">Off</option><option value="on">On</option>
    </select>
    {current !== null && !mixed ? <span className="unit-field">
      <input type="number" min={0} max={3650} step={1} aria-label={`${label}: days`} disabled={disabled} value={draft}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
      <span className="t3" aria-hidden>days</span>
    </span> : null}
  </span>;
}

export function WorktreeCleanup() {
  const scope = useSettingsScope();
  const query = scope?.query ?? {};
  return <CleanupRules key={JSON.stringify(query)} query={query} />;
}

function CleanupRules({ query }: { query: ProjectScopesQuery }) {
  const scope = useSettingsScope();
  const read = useAsync("worktree-cleanup", (signal) => request<ScopedPreferencesResult>(
    "POST", "/api/settings/preferences/query", { scope: query, keys: ["worktree_cleanup", "storage_cleanup"] }, signal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (read.status === "loading") return <Loading label="Loading cleanup settings" rows={2} />;
  if (read.status === "error") return <ErrorState title="Couldn't load settings" failure={read.error} onRetry={read.reload} />;
  const snapshot = read.data;
  const row = snapshot.rows.find((entry) => entry.key === "worktree_cleanup");
  if (!row) return null;
  const legacy = snapshot.rows.find((entry) => entry.key === "storage_cleanup")?.environment.value;
  const legacyAge = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy.worktree_settled_after_days : null;
  const all = snapshot.catalog.selection.kind === "all_projects";
  const disabled = busy || read.refreshing || snapshot.catalog.selection.kind === "unavailable";
  const age = (value: unknown, inherit: unknown = row.environment.value): number | null => {
    const selected = policy(value);
    const own = !selected.mode ? policy(inherit) : selected;
    const candidate = own.mode === "off" ? null : own.mode === "custom" ? own.rules?.settled_after_days : legacyAge;
    return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 && candidate <= 3650 ? candidate : null;
  };
  const turn = (days: number | null): PreferenceEdit => ({ op: "set",
    value: days !== null ? { mode: "custom", rules: { settled_after_days: days } } : { mode: "off" } });
  const guard = async (write: () => Promise<void>): Promise<boolean> => {
    if (disabled || pending.current) return false;
    pending.current = true; setBusy(true); setError(null);
    try {
      await write();
      useUi.getState().bumpPreferencesRevision();
      if (mounted.current) read.reload();
      return true;
    } catch (failure) {
      if (mounted.current) {
        const reason = toFailure(failure); setError(reason.message);
        if (reason.status === 409) { read.reload(); scope?.reload(); }
      }
      return false;
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const put = (target: ProjectScopesQuery, version: string, current: ScopedPreferenceRow, edit: PreferenceEdit) =>
    request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", {
      scope: target, membership_version: version, if_match: { [current.key]: current.revision }, edits: { [current.key]: edit } });
  const retry = error ? <p role="alert" className="field-error">{error} <Button small disabled={disabled} onClick={read.reload}>Retry</Button></p> : null;
  if (all) return <ProjectsTable row={row} groups={snapshot.catalog.groups} age={age} turn={turn} disabled={disabled} retry={retry}
    write={(group, edit) => guard(async () => {
      const target: ProjectScopesQuery = { selection: { kind: "project_group", group_key: group.key } };
      const fresh = await request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: target, keys: [row.key] });
      const current = fresh.rows.find((entry) => entry.key === row.key);
      if (current) await put(target, fresh.catalog.version, current, edit(current));
    })} />;
  const ages = row.members.map((member) => age(member.view.value));
  const mixed = ages.some((value) => value !== ages[0]);
  const current = ages[0] ?? null;
  const view = row.members[0]?.view ?? row.environment;
  return <SettingGroup>
    {retry}
    <SettingRow title={TITLE} description="Merged or archived worktrees, untouched for the days set" actions={
      <div className="setting-inheritance-actions">
        <PreferenceInheritance row={{ key: row.key, title: TITLE }} view={view} global={row.environment} members={row.members} mixed={mixed}
          disabled={disabled} onResetOverrides={() => undefined} />
        {view.source === "project" ? <Button small tone="quiet" disabled={disabled} aria-label={`Reset ${TITLE} to default`} title="Reset to inherited value"
          onClick={() => { void guard(async () => { await put(query, snapshot.catalog.version, row, { op: "inherit" }); }); }}>Inherit</Button> : null}
      </div>}>
      <CleanupSelect label={TITLE} current={mixed ? null : current} mixed={mixed} disabled={disabled}
        set={(days) => { void guard(async () => { await put(query, snapshot.catalog.version, row, turn(days)); }); }} />
    </SettingRow>
  </SettingGroup>;
}

/** Every project with its own switch (s-x-worktrees-cleanup). The settled-worktree counts and sizes have no data yet, so that column is left out. */
function ProjectsTable({ row, groups, age, turn, write, disabled, retry }: {
  row: ScopedPreferenceRow;
  groups: ProjectScopeGroup[];
  age(value: unknown): number | null;
  turn(days: number | null): PreferenceEdit;
  write(group: ProjectScopeGroup, edit: (current: ScopedPreferenceRow) => PreferenceEdit): Promise<boolean>;
  disabled: boolean;
  retry: React.ReactNode;
}) {
  const columns = "minmax(0, 1fr) 230px";
  return <SettingGroup>
    {retry}
    <div role="table" aria-label="Automatic worktree cleanup by project" className="set-tbl">
      <div role="row" className="set-tr h" style={{ gridTemplateColumns: columns }}><span role="columnheader">Project</span><span role="columnheader">Automatic worktree cleanup</span></div>
      {groups.map((group) => {
        const override = row.overrides.find((entry) => group.members.some((member) => member.project_id === entry.project_id));
        const value: JsonValue = override ? override.value : row.environment.value;
        const current = age(value);
        const view = override ? { ...row.environment, value: override.value, source: "project" } : row.environment;
        return <div role="row" key={group.key} className="set-tr" style={{ gridTemplateColumns: columns }}>
          <span role="cell">{group.label}</span>
          <span role="cell" className="set-inline-control">
            <span className="setting-inheritance-actions">
              <PreferenceInheritance row={{ key: row.key, title: TITLE }} view={view} global={row.environment} disabled={disabled}
                onResetOverrides={() => undefined} />
            </span>
            <CleanupSelect label={`${TITLE} for ${group.label}`} current={current} disabled={disabled}
              set={(days) => { void write(group, () => turn(days)); }} />
          </span>
        </div>;
      })}
    </div>
  </SettingGroup>;
}
