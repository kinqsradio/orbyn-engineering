import { useEffect, useRef, useState } from "react";
import { request } from "../../api/client";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { Button } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { ModelPickerTrigger } from "../thread/ModelPicker";
import { useModelStore } from "../thread/modelStore";
import { PreferenceInheritance } from "./PreferenceRows";
import { useSettingsScope } from "./SettingsScopeContext";
import { MODEL_DEFAULT_KEYS, modelDefaultChange, type DefaultModelChoice } from "./modelDefaultChange";

type Edit = DefaultModelChoice | "inherit" | { reset: string[] };

export function ProjectModelDefaults({ query, disabled = false }: { query: ProjectScopesQuery; disabled?: boolean }) {
  return <ModelDefaults key={JSON.stringify(query)} query={query} disabled={disabled} />;
}

function ModelDefaults({ query, disabled }: { query: ProjectScopesQuery; disabled: boolean }) {
  const scope = useSettingsScope();
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const modelsByEngine = useModelStore((state) => state.byEngine);
  const result = useAsync("project-model-defaults", (signal) => request<ScopedPreferencesResult>("POST",
    "/api/settings/preferences/query", { scope: query, keys: MODEL_DEFAULT_KEYS }, signal));
  const [draft, setDraft] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const data = result.data;
  const rows = MODEL_DEFAULT_KEYS.map((key) => data?.rows.find((row) => row.key === key));
  const engineRow = rows[0], modelRow = rows[1];
  const unavailable = !data || !engineRow || !modelRow || data.catalog.selection.kind === "unavailable";
  const blocked = disabled || saving || result.status !== "ready" || result.refreshing || unavailable || conflict;
  const commit = async (edit: Edit) => {
    if (pending.current || blocked || !data) return;
    pending.current = true;
    setSaving(true); setDraft(edit); setError(null);
    try {
      const changed = await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences",
        modelDefaultChange(data, query, edit));
      useUi.getState().bumpPreferencesRevision();
      if (mounted.current) { result.setData(changed); setDraft(null); }
    } catch (failure) {
      if (mounted.current) {
        const reason = toFailure(failure);
        setError(reason.message); setConflict(reason.status === 409);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  if (result.status === "loading") return <Loading label="Loading model defaults" rows={1} />;
  if (result.status === "error" && !data) return <ErrorState title="Couldn't load model defaults" failure={result.error} onRetry={result.reload} />;
  if (!data || !engineRow || !modelRow) return <p className="field-error" role="alert">Model defaults are unavailable.</p>;
  const all = data.catalog.selection.kind === "all_projects";
  const mixed = engineRow.mixed || modelRow.mixed;
  const selected = draft !== null && typeof draft === "object" && "engine" in draft ? draft : {
    engine: typeof engineRow.value === "string" ? engineRow.value : "",
    model: typeof modelRow.value === "string" && modelRow.value ? modelRow.value : null,
  };
  const representative = engines.find((engine) => engine.id === selected.engine) ?? engines.find((engine) => engine.installed);
  const missingProvider = selected.engine !== "" && !engines.some((engine) => engine.id === selected.engine);
  const listedModel = representative && modelsByEngine[representative.id]?.models.some((model) => model.id === selected.model);
  const triggerLabel = mixed && !draft ? "Mixed"
    : missingProvider ? [selected.engine, selected.model].filter(Boolean).join(" / ")
    : !selected.model ? "Automatic" : !listedModel ? selected.model : undefined;
  const overrides = [...new Set(rows.flatMap((row) => row?.overrides.map((entry) => entry.project_id) ?? []))];
  const hasOverride = rows.some((row) => row?.members.some((member) => member.view.source === "project"));
  return <SettingGroup title="New threads">
    <SettingRow title="Model" description={all ? "Default model for new threads. Projects can override it." : "Model for new threads in this project."} actions={
      <div className="setting-inheritance-actions">
        {rows.map((row) => row ? <PreferenceInheritance key={row.key}
          row={{ key: row.key, title: row.key === "default_engine" ? "Default provider" : "Default model" }}
          view={row.members[0]?.view ?? row.environment} global={row.environment} members={row.members}
          mixed={row.mixed} overrides={all ? row.overrides : []} disabled={blocked}
          onResetOverrides={(ids) => { void commit({ reset: ids }); }}
          onOpenOverride={(id) => {
            const group = data.catalog.groups.find((entry) => entry.members.some((member) => member.project_id === id));
            if (group) scope?.select({ kind: "checkout", group_key: group.key, project_id: id });
          }} /> : null)}
        {!all && hasOverride ? <Button small tone="quiet" disabled={blocked} onClick={() => { void commit("inherit"); }}>Inherit</Button> : null}
        {all && overrides.length > 0 ? <Button small tone="quiet" disabled={blocked}
          onClick={() => { void commit({ reset: overrides }); }}>Reset all</Button> : null}
      </div>
    }>
      <fieldset className="preference-control" disabled={blocked} aria-busy={saving || undefined}>
        {representative ? <ModelPickerTrigger engines={engines} selected={{ engine: representative.id, model: selected.model }} disabled={blocked}
          triggerLabel={triggerLabel}
          onPick={(choice) => { void commit(choice); }} /> : <span>No providers available</span>}
        {(selected.engine || selected.model || mixed) ? <Button small tone="quiet" disabled={blocked}
          onClick={() => { void commit({ engine: "", model: null }); }}>Automatic</Button> : null}
      </fieldset>
    </SettingRow>
    {error || result.error ? <div className="field-error" role="alert">
      {error ?? result.error?.message}
      <Button small disabled={saving || result.refreshing} onClick={() => {
        void result.reload().then(() => { if (mounted.current) setConflict(false); });
      }}>Reload</Button>
      {draft ? <Button small disabled={blocked} onClick={() => { void commit(draft); }}>Retry</Button> : null}
    </div> : null}
  </SettingGroup>;
}
