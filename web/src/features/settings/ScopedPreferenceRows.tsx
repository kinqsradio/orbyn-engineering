import { useEffect, useRef, useState } from "react";
import { request } from "../../api/client";
import type { JsonValue } from "../../api/types";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ScopedPreferenceRow } from "../../generated/ScopedPreferenceRow";
import type { PreferenceEdit } from "../../generated/PreferenceEdit";
import { toFailure, useAsync } from "../../lib/useAsync";
import { ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { Button } from "../../ui/controls";
import { PreferenceInheritance, type PreferenceRow, type PreferenceControl, type PreferenceSaveResult } from "./PreferenceRows";
import { useSettingsScope } from "./SettingsScopeContext";
import { runHandlers } from "../../app/shortcuts";

/** Read and mutation identities stay attached to the scope that produced them. */
export function ScopedRows({ groups, query }: {
  groups: { title: string; rows: PreferenceRow[] }[];
  query: ProjectScopesQuery;
}) {
  const scope = useSettingsScope();
  const keys = groups.flatMap((group) => group.rows.map((row) => row.key));
  const list = useAsync(JSON.stringify([query, keys]), (signal) =>
    request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: query, keys }, signal));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (list.status === "loading") return <Loading label="Loading settings" rows={3} />;
  if (list.status === "error") return <ErrorState title="Couldn't load settings" failure={list.error} onRetry={list.reload} />;
  const result = list.data;
  const all = result.catalog.selection.kind === "all_projects";
  const disabled = busy || list.refreshing || result.catalog.selection.kind === "unavailable";
  const commit = async (row: ScopedPreferenceRow, edit: PreferenceEdit): Promise<PreferenceSaveResult> => {
    if (pending.current || disabled) return { saved: false, error: null };
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const changed = await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", {
        scope: query, membership_version: result.catalog.version,
        if_match: { [row.key]: row.revision }, edits: { [row.key]: edit },
      });
      if (mounted.current) list.reload();
      if (row.key === "default_project_scripts") runHandlers("projectActions.reload");
      return { saved: true, row: changed.rows.find((value) => value.key === row.key) };
    } catch (failure) {
      const message = toFailure(failure).message;
      if (mounted.current) setError(message);
      return { saved: false, error: message };
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = (row: ScopedPreferenceRow, edit: PreferenceEdit) => { void commit(row, edit); };
  return <>
    {error ? <p className="field-error" role="alert">{error} <button type="button" disabled={busy} onClick={list.reload}>Retry</button></p> : null}
    {groups.map((group) => <SettingGroup key={group.title} title={group.title}>
      {group.rows.map((row) => {
        const value = result.rows.find((entry) => entry.key === row.key);
        if (!value) return null;
        const hasOverride = value.members.some((member) => member.view.source === "project");
        return <SettingRow key={row.key} title={row.title} description={row.description} actions={
          <div className="setting-inheritance-actions">
            <PreferenceInheritance row={row} view={value.members[0]?.view ?? value.environment} global={value.environment}
              members={value.members} mixed={value.mixed} overrides={all ? value.overrides : []} disabled={disabled}
              onResetOverrides={(ids) => save(value, { op: "reset_overrides", project_ids: ids })}
              onOpenOverride={(id) => {
                const group = result.catalog.groups.find((entry) => entry.members.some((member) => member.project_id === id));
                if (group) scope?.select({ kind: "checkout", group_key: group.key, project_id: id });
              }} />
            {!all && hasOverride ? <Button small tone="quiet" disabled={disabled}
              aria-label={`Reset ${row.title} to default`} title="Reset to inherited value" onClick={() => save(value, { op: "inherit" })}>Inherit</Button> : null}
            {all && value.environment.source === "global" ? <Button small tone="quiet" disabled={disabled}
              aria-label={`Reset ${row.title} to default`} onClick={() => save(value, { op: "inherit" })}>Reset</Button> : null}
          </div>
        }>
          <fieldset className="preference-control" disabled={disabled || (!all && !value.project_scoped)} aria-busy={busy || undefined}>
            {/* Action dialogs own their drafts and return focus after the saved list refreshes. */}
            <ValueControl key={row.key === "default_project_scripts" ? row.key : value.revision} row={row} value={value} control={{ disabled: disabled || (!all && !value.project_scoped), mixed: value.mixed, commit: (edit) => commit(value, edit) }} save={(next) => save(value, { op: "set", value: next as JsonValue })} />
          </fieldset>

        </SettingRow>;
      })}
    </SettingGroup>)}
  </>;
}

function ValueControl({ row, value, save, control }: { row: PreferenceRow; value: ScopedPreferenceRow; control: PreferenceControl; save(value: unknown): void }) {
  const touched = useRef(false);
  if (row.render) return <div onChangeCapture={() => { touched.current = true; }}>
    {value.mixed ? <span>Mixed</span> : null}
    {row.render(value.value, (next) => { if (!value.mixed || touched.current) save(next); }, control)}
  </div>;
  if (row.options) return <select aria-label={row.title} value={value.mixed ? "__mixed__" : String(value.value ?? "")}
    onChange={(event) => save(row.parse ? row.parse(event.target.value) : event.target.value)}>
    {value.mixed ? <option value="__mixed__" disabled>Mixed</option> : null}
    {row.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
  if (typeof value.default === "boolean") return <input type="checkbox" role="switch" aria-label={row.title}
    aria-checked={value.mixed ? "mixed" : value.value === true}
    ref={(element) => { if (element) element.indeterminate = value.mixed; }}
    checked={!value.mixed && value.value === true} onChange={(event) => save(event.target.checked)} />;
  const props = {
    "aria-label": row.title, placeholder: value.mixed ? "Mixed" : undefined,
    defaultValue: value.mixed ? "" : String(value.value ?? ""),
    onChange: () => { touched.current = true; },
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!touched.current) return;
      const next = row.parse ? row.parse(event.target.value) : typeof value.default === "number" ? Number(event.target.value) : event.target.value;
      if (value.mixed || !Object.is(next, value.value)) save(next);
    },
  };
  return row.multiline ? <textarea {...props} rows={2} /> : <input {...props} type={typeof value.default === "number" ? "number" : "text"} />;
}
