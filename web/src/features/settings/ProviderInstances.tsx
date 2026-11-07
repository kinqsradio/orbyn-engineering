import { useEffect, useRef, useState } from "react";
import { api, request } from "../../api/client";
import type { EngineStatus, JsonValue } from "../../api/types";
import type { ProviderInstance } from "../../generated/ProviderInstance";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { useSettingsScope } from "./SettingsScopeContext";
import { formatArgs, INSTANCE_COLORS, newInstanceId, parseArgs, patchInstance, readInstance, validCompactWindow, validInstanceId, accentColor } from "./providerInstanceData";
import "./ProviderInstances.css";

export interface InstanceStore {
  raw: JsonValue[];
  instances: ProviderInstance[];
  /** Writes are blocked while loading, saving, conflicted or when the saved list is ambiguous. */
  disabled: boolean;
  /** A failure from a change with no dialog of its own, such as the In use switch. */
  error: string | null;
  conflict: boolean;
  /** Saves the whole list; resolves to null, or the reason it was refused. */
  save(next: JsonValue[]): Promise<string | null>;
  reload(): void;
}

/** The saved provider instances, written with the environment's compare-and-set. */
export function useProviderInstances(): InstanceStore {
  const scope = useSettingsScope();
  const preferences = useAsync("provider-instances", (signal) => request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: {}, keys: ["provider_instances"] }, signal));
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [conflict, setConflict] = useState(false);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useWorkspace((state) => state.refreshEngines);
  const row = preferences.data?.rows.find((entry) => entry.key === "provider_instances");
  const raw = Array.isArray(row?.value) ? row.value : [];
  const instances = raw.flatMap((value) => { const parsed = readInstance(value); return parsed ? [parsed] : []; });
  const unavailable = scope !== null && (scope.loading || scope.error !== null || !scope.catalog || scope.catalog.selection.kind === "unavailable");
  const ambiguous = new Set(instances.map((instance) => instance.id)).size !== instances.length;
  const disabled = ambiguous || busy || conflict || unavailable || preferences.status !== "ready" || preferences.refreshing || !row || !Array.isArray(row.value);
  const save = async (next: JsonValue[]): Promise<string | null> => {
    if (pending.current || disabled || !row || !preferences.data) return "Provider settings aren't ready yet.";
    pending.current = true; setBusy(true); setError(null);
    try {
      const changed = await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", { scope: {}, membership_version: preferences.data.catalog.version,
        if_match: { provider_instances: row.revision }, edits: { provider_instances: { op: "set", value: next } } });
      useUi.getState().bumpPreferencesRevision();
      if (mounted.current) preferences.setData(changed);
      void refresh();
      return null;
    } catch (failure) {
      const reason = toFailure(failure);
      if (mounted.current && reason.status === 409) setConflict(true);
      return reason.message;
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return {
    raw, instances, disabled, conflict,
    error: error ?? preferences.error?.message ?? null,
    save,
    reload() { setConflict(false); setError(null); preferences.reload(); },
  };
}

/** A path that names a file itself. Anything else is a bare name the engines find on PATH. */
const absolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");

/**
 * What running the typed program with `--version` shows: its version, or why it won't run.
 * It runs only when asked (on leaving the field), never while typing, and it is advice:
 * only a missing absolute path blocks Save.
 */
function useProgramCheck(program: string): { found: string | null; problem: string | null; blocks: boolean; run(): void } {
  const [result, setResult] = useState<{ program: string; found: string | null; problem: string | null; blocks: boolean } | null>(null);
  const path = program.trim();
  const latest = useRef(path);
  latest.current = path;
  const run = () => {
    if (path === "") return;
    api.probeBinary(path).then(
      (probe) => {
        if (latest.current !== path) return;
        setResult(probe.exists
          ? { program: path, found: probe.version ? `Found. Version ${probe.version}.` : probe.problem ? null : "Found.", problem: probe.problem, blocks: false }
          : { program: path, found: null, problem: probe.problem ?? "No file at this path.", blocks: absolutePath(path) });
      },
      // A check that could not run says nothing about the program; saving stays possible.
      () => { if (latest.current === path) setResult(null); },
    );
  };
  const shown = result && result.program === path ? result : { found: null, problem: null, blocks: false };
  return { ...shown, run };
}

const requiredProgram = (driver: string) => driver === "_local_acp";

/** The dialog for one instance: its name, colour, binary, auto-compact window and arguments. */
export function InstanceEditor({ store, engines, instance, create, onClose, onSaved }: {
  store: InstanceStore;
  /** Provider drivers, to know which settings the instance has. */
  engines: EngineStatus[];
  instance: ProviderInstance;
  /** Adds a new instance instead of changing a saved one. */
  create?: { program: string; title: string };
  onClose(): void;
  onSaved?(instance: ProviderInstance): void;
}) {
  const driver = engines.find((engine) => engine.id === instance.driver);
  const local = instance.driver === "_local_acp";
  const first = { name: instance.name ?? "", accent: instance.accent ?? "", program: instance.program ?? create?.program ?? "", compact: instance.auto_compact_window ?? "", args: formatArgs(instance.args ?? []) };
  const [draft, setDraft] = useState(first);
  const [reason, setReason] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof first>) => { setDraft({ ...draft, ...patch }); setReason(null); };
  const changed = create ? true : (Object.keys(first) as (keyof typeof first)[]).some((key) => first[key] !== draft[key]);
  const compactOk = validCompactWindow(draft.compact.trim());
  const check = useProgramCheck(draft.program);
  const ids = new Set([...engines.map((engine) => engine.id), ...store.instances.map((entry) => entry.id)]);
  const newId = create ? newInstanceId(local ? "acp" : instance.driver, draft.name, ids) : instance.id;
  const ready = changed && compactOk && !check.blocks && !store.disabled && !saving && validInstanceId(newId) && (!requiredProgram(instance.driver) || draft.program.trim() !== "") && (!create || draft.name.trim() !== "");
  const fields = (): Record<string, JsonValue | undefined> => ({
    name: draft.name.trim() || undefined, accent: accentColor(draft.accent) ?? undefined, program: draft.program.trim() || undefined,
    auto_compact_window: draft.compact.trim() || undefined, ...(driver?.tier === "native" ? {} : { args: parseArgs(draft.args) }),
  });
  const submit = async () => {
    setSaving(true);
    const next: ProviderInstance = { ...instance, id: newId, enabled: true };
    const failure = create
      ? await store.save([...store.raw, { id: newId, driver: instance.driver, enabled: true, ...Object.fromEntries(Object.entries(fields()).filter(([, value]) => value !== undefined)) } as JsonValue])
      : await store.save(patchInstance(store.raw, instance.id, fields()));
    setSaving(false);
    if (failure) { setReason(failure); return; }
    onSaved?.(next);
    onClose();
  };
  const pathLabel = local || driver?.tier === "acp" ? "Executable" : "Binary path";
  const colors = draft.accent && !(INSTANCE_COLORS as readonly string[]).includes(draft.accent) ? [...INSTANCE_COLORS, draft.accent] : INSTANCE_COLORS;
  return (
    <Dialog title={create?.title ?? `Edit ${driver?.name ?? instance.driver}${instance.name ? ` · ${instance.name}` : ""}`} onClose={onClose} busy={saving} className="provider-dialog"
      footer={<><Button data-dialog-focus onClick={onClose} disabled={saving}>Cancel</Button><Button tone="primary" disabled={!ready} onClick={() => void submit()}>Save</Button></>}>
      <div className="fld">
        <label htmlFor="instance-name">Display name</label>
        <input id="instance-name" value={draft.name} spellCheck={false} onChange={(event) => set({ name: event.target.value })} />
      </div>
      <div className="fld" role="group" aria-label="Colour">
        <label>Colour</label>
        <div className="swatches">
          {colors.map((color) => (
            <button key={color} type="button" className="swatch" style={{ background: color }} aria-label={`Colour ${color}`} aria-pressed={draft.accent === color}
              onClick={() => set({ accent: draft.accent === color ? "" : color })} />
          ))}
        </div>
      </div>
      <div className={reason || check.problem ? "fld error" : "fld"}>
        <label htmlFor="instance-program">{pathLabel}</label>
        <input id="instance-program" className="mono" value={draft.program} spellCheck={false} aria-invalid={reason || check.problem ? true : undefined}
          aria-describedby={reason || check.problem || check.found ? "instance-program-note" : undefined}
          onChange={(event) => set({ program: event.target.value })} onBlur={check.run} />
        {reason || check.problem ? <small id="instance-program-note" className="err" role="alert">{reason ?? check.problem}</small>
          : check.found ? <small id="instance-program-note" className="hint">{check.found}</small> : null}
      </div>
      {instance.driver === "claude" ? (
        <div className={compactOk ? "fld" : "fld error"}>
          <label htmlFor="instance-compact">Auto-compact window</label>
          <input id="instance-compact" inputMode="numeric" placeholder="Default" value={draft.compact} spellCheck={false} onChange={(event) => set({ compact: event.target.value })} />
          {compactOk ? <small className="hint">100,000 to 1,000,000 tokens. Empty uses Claude’s default.</small> : <small className="err">Use 100000 to 1000000.</small>}
        </div>
      ) : null}
      {driver?.tier === "native" ? null : (
        <div className="fld">
          <label htmlFor="instance-args">Arguments</label>
          <input id="instance-args" className="mono" value={draft.args} spellCheck={false} onChange={(event) => set({ args: event.target.value })} />
          <small className="hint">Added after the command every time.</small>
        </div>
      )}
    </Dialog>
  );
}

/** What Orbyn found on this computer, plus the registry and a local command. */
export function AddProviderDialog({ engines, onClose, onRegistry, onChosen }: {
  engines: EngineStatus[];
  onClose(): void;
  onRegistry(): void;
  onChosen(engine: EngineStatus | "_local_acp"): void;
}) {
  const found = engines.filter((engine) => !engine.instance_of && engine.installed && (engine.tier === "native" || engine.tier === "acp"));
  const [choice, setChoice] = useState<string>(found[0]?.id ?? "_registry");
  const go = () => {
    if (choice === "_registry") onRegistry();
    else if (choice === "_local_acp") onChosen("_local_acp");
    else { const engine = found.find((entry) => entry.id === choice); if (engine) onChosen(engine); }
  };
  const options = [
    ...found.map((engine) => ({ id: engine.id, name: engine.name, note: `Found at ${engine.path ?? "an unknown path"}${engine.version ? ` · ${engine.version}` : ""}` })),
    { id: "_registry", name: "Another agent from the ACP registry", note: "Opens the registry" },
    { id: "_local_acp", name: "A local ACP command", note: "Runs a program you point to" },
  ];
  return (
    <Dialog title="Add a provider" onClose={onClose} className="provider-dialog"
      footer={<><Button onClick={onClose}>Cancel</Button><Button tone="primary" onClick={go}>Continue</Button></>}>
      <div role="radiogroup" aria-label="Provider" className="choices">
        {options.map((option) => (
          <label key={option.id} className={choice === option.id ? "choice on" : "choice"}>
            <input type="radio" name="provider" checked={choice === option.id} onChange={() => setChoice(option.id)} />
            <span><b>{option.name}</b><small>{option.note}</small></span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
