import { useEffect, useRef, useState } from "react";
import { request } from "../../api/client";
import type { JsonValue } from "../../api/types";
import type { PreferenceEdit } from "../../generated/PreferenceEdit";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import { toFailure, useAsync } from "../../lib/useAsync";
import { Button } from "../../ui/controls";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { ErrorState, Loading } from "../../ui/states";
import { Advanced } from "./PreferenceRows";
import { useSettingsScope } from "./SettingsScopeContext";

type Policy = { mode?: string; rules?: { settled_after_days?: unknown } };
const policy = (value: unknown): Policy => value !== null && typeof value === "object" ? value as Policy : {};

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
  const disabled = busy || read.refreshing || !row || snapshot.catalog.selection.kind === "unavailable";
  const modes = row?.members.map((member) => member.view.source === "project" ? policy(member.view.value).mode ?? "inherit" : "inherit") ?? [];
  const mixedMode = modes.some((value) => value !== modes[0]);
  const mode = modes[0] ?? "inherit";
  const age = (value: unknown): number | null => {
    const selected = policy(value);
    const own = !all && !selected.mode ? policy(row.environment.value) : selected;
    const candidate = own.mode === "off" ? null : own.mode === "custom" ? own.rules?.settled_after_days : legacyAge;
    return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 && candidate <= 3650 ? candidate : null;
  };
  const ages = all ? [age(row?.value)] : row?.members.map((member) => age(member.view.value)) ?? [];
  const mixedAge = ages.some((value) => value !== ages[0]);
  const commit = async (edit: PreferenceEdit): Promise<boolean> => {
    if (disabled || pending.current || !row) return false;
    pending.current = true; setBusy(true); setError(null);
    try {
      const changed = await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", {
        scope: query, membership_version: snapshot.catalog.version,
        if_match: { [row.key]: row.revision }, edits: { [row.key]: edit },
      });
      if (mounted.current) {
        read.setData({ ...snapshot, catalog: changed.catalog, rows: snapshot.rows.map((previous) => changed.rows.find((next) => next.key === previous.key) ?? previous) });
      }
      return true;
    } catch (failure) {
      if (mounted.current) {
        const reason = toFailure(failure); setError(reason.message);
        if (reason.status === 409) { read.reload(); scope?.reload(); }
      }
      return false;
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const set = (value: JsonValue) => commit({ op: "set", value });
  return <SettingGroup title="Cleanup">
    {error ? <p role="alert" className="field-error">{error} <Button small disabled={disabled} onClick={read.reload}>Retry</Button></p> : null}
    {!all ? <SettingRow title="Automatic worktree cleanup" description={mode === "off" ? "Keep this project's worktrees until you delete them manually." : mode === "custom" ? "Use these rules for this project." : "Use each machine's worktree cleanup settings."}>
      <select aria-label="Automatic worktree cleanup" disabled={disabled} value={mixedMode ? "mixed" : mode} onChange={(event) => {
        const next = event.target.value;
        void (next === "inherit" ? commit({ op: "inherit" }) : set(next === "off" ? { mode: "off" } : { mode: "custom", rules: {} }));
      }}>
        {mixedMode ? <option value="mixed" disabled>Mixed</option> : null}
        <option value="inherit">Inherit</option><option value="off">Off</option><option value="custom">Custom</option>
      </select>
    </SettingRow> : null}
    <div hidden={!(all || (!mixedMode && mode === "custom"))}><Advanced><SettingRow title="Delete settled worktrees" description="Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.">
      <SettledRetention value={ages[0] ?? null} mixed={mixedAge} disabled={disabled} save={(days) => set({ mode: "custom", rules: { settled_after_days: days } })} />
    </SettingRow></Advanced></div>
  </SettingGroup>;
}

function SettledRetention({ value, mixed, disabled, save }: { value: number | null; mixed: boolean; disabled: boolean; save(days: number | null): Promise<boolean> }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(mixed || value === null ? "" : String(value)); }, [value, mixed, dirty]);
  const commit = async () => {
    if (!dirty || disabled) return;
    if (draft.trim() === "" || !Number.isFinite(Number(draft))) { setDirty(false); return; }
    const days = Math.max(0, Math.min(3650, Math.round(Number(draft))));
    setDraft(String(days));
    if (!mixed && days === value) { setDirty(false); return; }
    if (await save(days)) setDirty(false);
  };
  return <div className="retention-control">
    {mixed || value !== null || dirty ? <><input aria-label="Delete settled worktrees in days" type="number" min={0} max={3650} step={1} disabled={disabled} placeholder={mixed ? "Mixed" : undefined} value={draft} onChange={(event) => { setDraft(event.target.value); setDirty(true); }} onBlur={() => { void commit(); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } }} /><span>days</span></> : <span className="muted">Off</span>}
    <input type="checkbox" role="switch" aria-label="Delete settled worktrees" aria-checked={mixed ? "mixed" : value !== null} checked={!mixed && value !== null} disabled={disabled} onChange={(event) => { void save(event.target.checked ? 8 : null).then((saved) => { if (saved) setDirty(false); }); }} />
  </div>;
}
