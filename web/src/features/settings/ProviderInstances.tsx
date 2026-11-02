import { useEffect, useRef, useState, type ReactNode } from "react";
import { request } from "../../api/client";
import type { EngineStatus, JsonValue } from "../../api/types";
import type { ProviderInstance } from "../../generated/ProviderInstance";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Button, Field } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { useSettingsScope } from "./SettingsScopeContext";
import { accentColor, newInstanceId, patchInstance, readInstance, validInstanceId } from "./providerInstanceData";
import { ProviderInstanceColor } from "./ProviderInstanceColor";
import "./ProviderInstances.css";

function DraftField({ label, value, disabled, save, normalize = (next) => next }: { label: string; value: string; disabled: boolean; save(value: string): Promise<boolean>; normalize?(value: string): string }) {
  const [draft, setDraft] = useState(value), [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); if (draft === seen) setDraft(value); }
  const commit = () => { if (!disabled && draft !== value) { const submitted = draft; void save(submitted).then((saved) => { if (saved) setDraft((current) => current === submitted ? normalize(submitted) : current); }); } };
  return <Field label={label}>{(props) => <input {...props} value={draft} disabled={disabled} spellCheck={false}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.repeat) { event.preventDefault(); commit(); } }} />}</Field>;
}
export function ProviderArguments({ values, disabled, save }: { values: string[]; disabled: boolean; save(values: string[]): Promise<boolean> }) {
  return <SettingRow title="Arguments" description="One literal argument per row, in launch order."><div className="provider-arguments"><Button small disabled={disabled} onClick={() => void save([...values, ""])}>Add argument</Button>
    {values.map((value, index) => <div className="provider-argument" key={`${index}:${value}`}><DraftField label={`Argument ${index + 1}`} value={value} disabled={disabled} save={(next) => save(values.map((old, at) => at === index ? next : old))} />
      <Button small disabled={disabled} aria-label={`Remove argument ${index + 1}`} onClick={() => void save(values.filter((_, at) => at !== index))}>×</Button></div>)}
  </div></SettingRow>;
}

export function ProviderInstances({ engines, renderDriver, renderInstance, renderStatus }: { engines: EngineStatus[]; renderDriver(engine: EngineStatus): ReactNode; renderInstance?(engine: EngineStatus): ReactNode; renderStatus?(engine: EngineStatus): ReactNode }) {
  const scope = useSettingsScope();
  const preferences = useAsync("provider-instances", (signal) => request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: {}, keys: ["provider_instances"] }, signal));
  const [selected, setSelected] = useState<string | null>(null), [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [conflict, setConflict] = useState(false);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useWorkspace((state) => state.refreshEngines);
  const row = preferences.data?.rows.find((entry) => entry.key === "provider_instances");
  const raw = Array.isArray(row?.value) ? row.value : [];
  const instances = raw.flatMap((value) => { const parsed = readInstance(value); return parsed ? [parsed] : []; });
  const bases = engines.filter((engine) => !engine.instance_of);
  const active = instances.find((instance) => instance.id === selected);
  const driver = bases.find((engine) => engine.id === active?.driver);
  const base = bases.find((engine) => engine.id === selected) ?? (selected === null ? bases[0] : undefined);
  const unavailable = scope !== null && (scope.loading || scope.error !== null || !scope.catalog || scope.catalog.selection.kind === "unavailable");
  const ambiguous = new Set(instances.map((instance) => instance.id)).size !== instances.length;
  const disabled = ambiguous || busy || conflict || unavailable || preferences.status !== "ready" || preferences.refreshing || !row || !Array.isArray(row.value);
  const viewKey = `${JSON.stringify(scope?.query ?? {})}:${selected ?? ""}`;
  const currentView = useRef({ key: viewKey });
  if (currentView.current.key !== viewKey) currentView.current = { key: viewKey };
  const save = async (next: JsonValue[]): Promise<boolean> => {
    if (pending.current || disabled || !row || !preferences.data) return false;
    pending.current = true; setBusy(true); setError(null); const view = currentView.current;
    try {
      const changed = await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", { scope: {}, membership_version: preferences.data.catalog.version,
        if_match: { provider_instances: row.revision }, edits: { provider_instances: { op: "set", value: next } } });
      if (mounted.current) preferences.setData(changed); void refresh(); return true;
    } catch (failure) {
      if (mounted.current) { const reason = toFailure(failure); if (reason.status === 409) setConflict(true); if (currentView.current === view) setError(reason.message); }
      return false;
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const update = (fields: Record<string, JsonValue | undefined>) => active ? save(patchInstance(raw, active.id, fields)) : Promise.resolve(false);
  const remove = () => {
    if (!active || disabled) return;
    const view = currentView.current, id = active.id;
    void save(raw.filter((value) => readInstance(value)?.id !== id)).then((saved) => {
      if (saved && mounted.current && currentView.current === view) setSelected(null);
    });
  };
  return <><div className="form-actions"><Button small disabled={disabled} onClick={() => setAdding(true)}>Add provider</Button></div>
    {error || preferences.error || conflict ? <p className="field-error" role="alert">{error ?? preferences.error?.message ?? "Settings changed. Reload before saving."} <Button small disabled={busy || preferences.refreshing} onClick={() => { setConflict(false); setError(null); preferences.reload(); }}>Reload</Button></p> : null}
    <div className="provider-instance-layout"><nav aria-label="Providers" className="provider-instance-list">
      {bases.map((engine) => <Button small key={engine.id} tone={base?.id === engine.id ? "primary" : "quiet"} onClick={() => setSelected(engine.id)}>{engine.name}</Button>)}
      {instances.map((instance) => <div className="provider-instance-list-row" key={instance.id}><Button small tone={active?.id === instance.id ? "primary" : "quiet"} aria-label={`Select ${instance.name ?? instance.id}`} onClick={() => setSelected(instance.id)}>{instance.name ?? instance.id}</Button>
        <input type="checkbox" role="switch" aria-label={`Enable ${instance.name ?? instance.id}`} checked={instance.enabled} disabled={disabled} onChange={(event) => void save(patchInstance(raw, instance.id, { enabled: event.target.checked }))} /></div>)}
    </nav><div className="provider-instance-editor">{active ? <section key={active.id}>
      <SettingGroup title={active.name ?? active.id}><SettingRow title="Status" description={engines.find((engine) => engine.id === active.id)?.problem ?? (active.enabled ? undefined : "Disabled")}>
        {engines.find((engine) => engine.id === active.id) && renderStatus ? renderStatus(engines.find((engine) => engine.id === active.id)!) : null}
        <Button small disabled={disabled} aria-label={`Delete instance ${active.id}`} onClick={remove}>Delete</Button></SettingRow>
        <SettingRow title="Display name"><ProviderInstanceColor value={active.accent ?? ""} name={active.name ?? active.id} disabled={disabled} save={(value) => void update({ accent: accentColor(value) ?? undefined })} />
          <DraftField label="Display name" normalize={(value) => value.trim()} value={active.name ?? ""} disabled={disabled} save={(name) => update({ name: name.trim() || undefined })} /></SettingRow></SettingGroup>
      {driver || active.driver === "_local_acp" ? <SettingGroup title="Config"><DraftField label={active.driver === "_local_acp" || driver?.tier === "acp" ? "Executable" : "Binary path"} value={active.program ?? ""} normalize={(value) => value.trim()} disabled={disabled} save={(program) => update({ program: program.trim() || undefined })} />
        {driver?.tier === "native" ? null : <ProviderArguments values={active.args ?? []} disabled={disabled} save={(args) => update({ args })} />}</SettingGroup> : null}
      {engines.find((engine) => engine.id === active.id) && renderInstance ? renderInstance(engines.find((engine) => engine.id === active.id)!) : null}
    </section> : base ? <ul className="setting-list">{renderDriver(base)}</ul> : null}</div></div>
    {adding ? <AddProvider engines={bases} existing={new Set([...engines.map((engine) => engine.id), ...instances.map((instance) => instance.id)])} disabled={disabled} save={async (instance) => {
      const view = currentView.current; const added = await save([...raw, instance as unknown as JsonValue]); if (added && mounted.current && currentView.current === view) { setAdding(false); setSelected(instance.id); } return added;
    }} onClose={() => setAdding(false)} /> : null}
  </>;
}
function AddProvider({ engines, existing, disabled, save, onClose }: { engines: EngineStatus[]; existing: Set<string>; disabled: boolean;
  save(instance: ProviderInstance): Promise<boolean>; onClose(): void }) {
  const choices = engines.filter((engine) => engine.tier === "native" || engine.tier === "acp");
  const [step, setStep] = useState(0), [driver, setDriver] = useState(choices[0]?.id ?? "");
  const [label, setLabel] = useState(""), [idOverride, setIdOverride] = useState<string | null>(null), [accent, setAccent] = useState("");
  const [program, setProgram] = useState(""), [args, setArgs] = useState<string[]>([]);
  const chosen = engines.find((engine) => engine.id === driver);
  const id = idOverride ?? newInstanceId(driver === "_local_acp" ? "acp" : driver, label, existing), invalid = !validInstanceId(id) || existing.has(id);
  const local = driver === "_local_acp", lastStep = local ? 1 : 2;
  const config = <><Field label={local || chosen?.tier === "acp" ? "Executable" : "Binary path"}>{(props) => <input {...props} value={program} disabled={disabled} onChange={(event) => setProgram(event.target.value)} spellCheck={false} />}</Field>
    {chosen?.tier === "native" ? null : <ProviderArguments values={args} disabled={disabled} save={async (next) => { setArgs(next); return true; }} />}</>;
  return <Dialog title="Add provider" onClose={onClose} busy={disabled} footer={<><Button disabled={disabled} onClick={() => step === 0 ? onClose() : setStep(step - 1)}>{step === 0 ? "Cancel" : "Back"}</Button>
    {step < lastStep ? <Button disabled={disabled || !driver || (step === 1 && invalid) || (local && !program.trim())} onClick={() => setStep(step + 1)}>Next</Button>
      : <Button disabled={disabled || invalid || (local && !program.trim())} onClick={() => void save({ id, driver, enabled: true, ...(label.trim() ? { name: label.trim() } : {}), ...(accentColor(accent) ? { accent: accentColor(accent)! } : {}), ...(program.trim() ? { program: program.trim() } : {}), ...(chosen?.tier !== "native" ? { args } : {}) })}>Add instance</Button>}</>}>
    <p>{["Provider", "Identity", "Config"][step]}</p>
    {step === 0 ? <><div className="provider-instance-choices">{choices.map((engine) => <Button key={engine.id} aria-pressed={driver === engine.id} onClick={() => { setDriver(engine.id); setProgram(""); setArgs([]); }}>{engine.name}</Button>)}
      <Button aria-pressed={local} onClick={() => { setDriver("_local_acp"); setProgram(""); setArgs([]); }}>Local ACP command</Button></div>{local ? config : null}</>
      : step === 1 ? <><Field label="Label" hint="Shown in the provider list.">{(props) => <input {...props} value={label} disabled={disabled} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Work" />}</Field>
        <Field label="Instance ID" hint="Letters, digits, '-', or '_'.">{(props) => <input {...props} value={id} disabled={disabled} onChange={(event) => setIdOverride(event.target.value)} aria-invalid={invalid} />}</Field>
        <SettingRow title="Accent color" description="Optional marker shown in the picker."><ProviderInstanceColor value={accent} name={label || (local ? "Local ACP command" : driver)} disabled={disabled} save={setAccent} /></SettingRow></> : config}
  </Dialog>;
}
