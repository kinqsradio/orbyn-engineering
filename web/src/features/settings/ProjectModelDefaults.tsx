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
import { useEngineModels, useModelStore } from "../../state/modelStore";
import { PreferenceGroups, PreferenceInheritance } from "./PreferenceRows";
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
  const [engineRow, modelRow, effortRow, optionsRow] = rows;
  const unavailable = !data || rows.some((row) => !row) || data.catalog.selection.kind === "unavailable";
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
  if (!data || !engineRow || !modelRow || !effortRow || !optionsRow) return <p className="field-error" role="alert">Model defaults are unavailable.</p>;
  const all = data.catalog.selection.kind === "all_projects";
  const mixed = engineRow.mixed || modelRow.mixed;
  const tuningMixed = mixed || effortRow.mixed || optionsRow.mixed;
  const savedOptions = optionsRow.value && typeof optionsRow.value === "object" && !Array.isArray(optionsRow.value)
    ? Object.fromEntries(Object.entries(optionsRow.value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  const selected: Required<DefaultModelChoice> = draft !== null && typeof draft === "object" && "engine" in draft
    ? { effort: null, options: {}, ...draft } : {
      engine: typeof engineRow.value === "string" ? engineRow.value : "",
      model: typeof modelRow.value === "string" && modelRow.value ? modelRow.value : null,
      effort: typeof effortRow.value === "string" && effortRow.value ? effortRow.value : null,
      options: savedOptions,
    };
  const representative = engines.find((engine) => engine.id === selected.engine) ?? engines.find((engine) => engine.installed);
  const missingProvider = selected.engine !== "" && !engines.some((engine) => engine.id === selected.engine);
  const listedModel = representative && modelsByEngine[representative.id]?.models.some((model) => model.id === selected.model);
  const triggerLabel = mixed && !draft ? "Mixed"
    : missingProvider ? [selected.engine, selected.model].filter(Boolean).join(" / ")
    : !selected.model ? "Automatic" : !listedModel ? selected.model : undefined;
  const inheritance = (row: NonNullable<(typeof rows)[number]>, title: string) => <PreferenceInheritance key={row.key}
    row={{ key: row.key, title }} view={row.members[0]?.view ?? row.environment} global={row.environment} members={row.members}
    mixed={row.mixed} overrides={all ? row.overrides : []} disabled={blocked}
    onResetOverrides={(ids) => { void commit({ reset: ids }); }}
    onOpenOverride={(id) => {
      const group = data.catalog.groups.find((entry) => entry.members.some((member) => member.project_id === id));
      if (group) scope?.select({ kind: "checkout", group_key: group.key, project_id: id });
    }} />;
  const overrides = [...new Set(rows.flatMap((row) => row?.overrides.map((entry) => entry.project_id) ?? []))];
  const hasOverride = rows.some((row) => row?.members.some((member) => member.view.source === "project"));
  return <SettingGroup>
    <SettingRow title="Default model" description={all ? "Default model for new threads. Projects can override it." : "Overrides General"} actions={
      <div className="setting-inheritance-actions">
        {inheritance(engineRow, "Default provider")}
        {inheritance(modelRow, "Default model")}
        {!all && hasOverride ? <Button small tone="quiet" disabled={blocked} onClick={() => { void commit("inherit"); }}>Inherit</Button> : null}
        {all && overrides.length > 0 ? <Button small tone="quiet" disabled={blocked}
          onClick={() => { void commit({ reset: overrides }); }}>Reset all</Button> : null}
      </div>
    }>
      <fieldset className="preference-control" disabled={blocked} aria-busy={saving || undefined}>
        {representative ? <ModelPickerTrigger engines={engines} selected={{ engine: representative.id, model: selected.model }} disabled={blocked}
          triggerLabel={triggerLabel}
          onPick={(choice) => { void commit({ engine: choice.engine, model: choice.model, effort: null, options: {} }); }} />
          : <span>No providers available</span>}
        {(selected.engine || selected.model || mixed) ? <Button small tone="quiet" disabled={blocked}
          onClick={() => { void commit({ engine: "", model: null, effort: null, options: {} }); }}>Automatic</Button> : null}
      </fieldset>
    </SettingRow>
    <ModelTuning engine={representative?.id ?? null} selected={selected} mixed={tuningMixed} disabled={blocked}
      inheritance={<>{inheritance(effortRow, "Default effort")}{inheritance(optionsRow, "Default model options")}</>}
      onChange={(next) => { void commit(next); }} />
    {error || result.error ? <div className="field-error" role="alert">
      {error ?? result.error?.message}
      <Button small disabled={saving || result.refreshing} onClick={() => {
        void result.reload().then(() => { if (mounted.current) setConflict(false); });
      }}>Reload</Button>
      {draft ? <Button small disabled={blocked} onClick={() => { void commit(draft); }}>Retry</Button> : null}
    </div> : null}
  </SettingGroup>;
}

/**
 * Effort and the other options the default model offers, each left to the model
 * ("Automatic") or set. They are saved with the model, so choosing another model
 * clears them.
 */
function ModelTuning({ engine, selected, mixed, disabled, inheritance, onChange }: {
  engine: string | null;
  selected: Required<DefaultModelChoice>;
  mixed: boolean;
  disabled: boolean;
  inheritance: React.ReactNode;
  onChange(choice: Required<DefaultModelChoice>): void;
}) {
  const catalog = useEngineModels(engine);
  const model = selected.model ? catalog?.models.find((entry) => entry.id === selected.model) ?? null : null;
  const choices = model?.options ?? [];
  const description = !selected.model ? "Choose a model to set its effort and options."
    : choices.length === 0 ? "This model offers no effort or options." : "Saved with the default model.";
  return <SettingRow title="Effort and options" description={description} actions={
    <div className="setting-inheritance-actions">{inheritance}</div>
  }>
    <fieldset className="preference-control" disabled={disabled || choices.length === 0}>
      {choices.map((option) => {
        const effort = option.id === "effort";
        const value = effort ? selected.effort ?? "" : selected.options[option.id] ?? "";
        return <select key={option.id} aria-label={`Default ${option.label}`} value={mixed ? "__mixed__" : value}
          onChange={(event) => {
            const next = event.target.value;
            const options = { ...selected.options };
            if (!effort) { if (next) options[option.id] = next; else delete options[option.id]; }
            onChange({ ...selected, effort: effort ? next || null : selected.effort, options });
          }}>
          {mixed ? <option value="__mixed__" disabled>Mixed</option> : null}
          <option value="">{`${option.label}: automatic`}</option>
          {option.values.map((entry) => <option key={entry.id} value={entry.id}>{`${option.label}: ${entry.label}`}</option>)}
        </select>;
      })}
    </fieldset>
  </SettingRow>;
}

/** A select of the provider's known models plus Other…, which shows a field for a model id the service takes as free text. */
export function FallbackControl({ value, save, disabled }: { value: string; save(next: string): void; disabled: boolean }) {
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const engine = engines.find((entry) => entry.installed && !entry.instance_of)?.id ?? null;
  const models = useEngineModels(engine)?.models ?? [];
  const known = value === "" || models.some((model) => model.id === value);
  const [other, setOther] = useState(!known);
  const [draft, setDraft] = useState(value);
  const [touched, setTouched] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  const showOther = other || !known;
  return <div className="set-fallback">
    <select aria-label="Fallback model" disabled={disabled} value={showOther ? "__other" : value}
      onChange={(event) => {
        const next = event.target.value;
        if (next === "__other") { setOther(true); setTouched(false); if (known) setDraft(""); return; }
        setOther(false);
        save(next);
      }}>
      {value === "" && !showOther ? <option value="" disabled>Choose a model</option> : null}
      {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      <option value="__other">Other…</option>
    </select>
    {showOther ? <label className="set-fallback-id"><span>Model id</span>
      <input aria-label="Model id" className="mono" spellCheck={false} disabled={disabled} value={draft}
        onChange={(event) => { setTouched(true); setDraft(event.target.value); }}
        onBlur={() => { if (touched && draft.trim() !== value) save(draft.trim()); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label> : null}
  </div>;
}

/** The model a turn runs on when its own has left the provider's list; empty means none. */
export function FallbackModel({ disabled = false }: { disabled?: boolean }) {
  return <fieldset className="preference-control" disabled={disabled}>
    <PreferenceGroups groups={[{ title: "", rows: [{ key: "fallback_model", title: "Fallback model", inheritance: true,
      description: "Used when the default model is unavailable",
      render: (value, save, control) => <FallbackControl value={typeof value === "string" ? value : ""} save={save} disabled={control.disabled} /> }] }]} />
  </fieldset>;
}
