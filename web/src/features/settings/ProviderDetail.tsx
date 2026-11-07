import { ArrowDown, ArrowUp, ChevronLeft, Plus } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { EngineStatus } from "../../api/types";
import { authLabels } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { arrangeModels, modelKey, useEngineModels, useModelStore } from "../../state/modelStore";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, CopyCommand, IconButton } from "../../ui/controls";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { NativeSessions } from "./NativeSessions";
import { SettingsBanner } from "./SettingsBanner";
import { FeedbackAction, hasFeedback, UpdateAction, useCustomModels } from "./ProviderParts";
import type { InstanceStore } from "./ProviderInstances";
import { patchInstance } from "./providerInstanceData";

function AddModelDialog({ onClose, add, disabled, error }: { onClose(): void; add(id: string, label: string): Promise<boolean>; disabled: boolean; error: string | null }) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  return (
    <Dialog title="Add custom model" onClose={onClose} className="provider-dialog"
      footer={<><Button data-dialog-focus onClick={onClose}>Cancel</Button>
        <Button tone="primary" disabled={disabled || !id.trim()} onClick={() => void add(id, label).then((saved) => { if (saved) onClose(); })}>Add model</Button></>}>
      <div className="fld"><label htmlFor="custom-model-id">Model id</label><input id="custom-model-id" value={id} spellCheck={false} onChange={(event) => setId(event.target.value)} /></div>
      <div className="fld"><label htmlFor="custom-model-label">Display name</label><input id="custom-model-label" value={label} onChange={(event) => setLabel(event.target.value)} /></div>
      {/* A refused save keeps the draft here, so its reason shows here and not behind the dialog. */}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </Dialog>
  );
}

function Models({ engine }: { engine: EngineStatus }) {
  const hidden = useUi((state) => state.modelHidden);
  const order = useUi((state) => state.modelOrder);
  const setPrefs = useUi((state) => state.setPrefs);
  const listed = useEngineModels(engine.id);
  const refreshing = useModelStore((state) => state.loading[engine.id] ?? false);
  const error = useModelStore((state) => state.errors[engine.id] ?? null);
  const reload = useModelStore((state) => state.reload);
  const custom = useCustomModels(engine);
  const [adding, setAdding] = useState(false);
  const models = arrangeModels(engine.id, listed?.models ?? [], [], order);
  const customIds = new Set(custom.mine.map((model) => model.id));
  // A custom model moves past the next custom model; built-in models keep their place.
  const customAt = models.flatMap((model, at) => customIds.has(model.id) ? [at] : []);
  const move = (at: number, step: number) => {
    const target = customAt[customAt.indexOf(at) + step];
    if (target === undefined) return;
    const keys = models.map((model) => modelKey(engine.id, model.id));
    const [key] = keys.splice(at, 1);
    if (!key) return;
    keys.splice(target, 0, key);
    setPrefs({ modelOrder: [...order.filter((entry) => !keys.includes(entry)), ...keys] });
  };
  return (
    <>
      <p className="set-grp">Models</p>
      {error ? <p className="banner banner-warn" role="status">Couldn't refresh models. {error}{models.length > 0 ? " Showing the last available list." : " Try refreshing again."}</p> : null}
      <SettingGroup>
        {models.map((model, at) => {
          const key = modelKey(engine.id, model.id);
          const shown = !hidden.includes(key);
          return (
            <SettingRow key={model.id} title={model.label}>
              {customIds.has(model.id) ? <>
                <span className="set-pill">Custom</span>
                <span className="set-model-moves">
                  <IconButton label={`Move ${model.label} up`} disabled={at === customAt[0]} onClick={() => move(at, -1)}><ArrowUp size={14} aria-hidden /></IconButton>
                  <IconButton label={`Move ${model.label} down`} disabled={at === customAt[customAt.length - 1]} onClick={() => move(at, 1)}><ArrowDown size={14} aria-hidden /></IconButton>
                </span>
                <button type="button" className="set-red-link" aria-label={`Remove ${model.label}`} disabled={custom.disabled} onClick={() => void custom.remove(model.id)}>Remove</button>
              </> : null}
              <input type="checkbox" role="switch" aria-label={`Show ${model.label}`} checked={shown}
                onChange={() => setPrefs({ modelHidden: shown ? [...hidden, key] : hidden.filter((entry) => entry !== key) })} />
            </SettingRow>
          );
        })}
      </SettingGroup>
      {custom.error ? <p className="field-error" role="alert">{custom.error}{custom.retry ? <Button small onClick={custom.retry}>Retry</Button> : null}</p> : null}
      <div className="set-tools">
        <Button small disabled={custom.disabled} onClick={() => setAdding(true)}><Plus size={13} aria-hidden />Add custom model</Button>
        <Button small busy={refreshing} aria-label={`Refresh ${engine.name} models`} onClick={() => void reload(engine.id)}>Refresh models</Button>
      </div>
      {adding ? <AddModelDialog onClose={() => setAdding(false)} disabled={custom.disabled} add={custom.add} error={custom.error} /> : null}
    </>
  );
}

/** One provider, opened from its row: version, login, location, models, feedback and removal. */
export function ProviderDetail({ engine, store, onBack, onEdit }: {
  engine: EngineStatus;
  store: InstanceStore;
  onBack(): void;
  onEdit(): void;
}) {
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const instance = store.instances.find((entry) => entry.id === engine.id);
  const removable = instance !== undefined || engine.tier !== "native";
  const hasNewer = engine.latest !== null && engine.latest !== engine.version;
  const recheck = async () => {
    setChecking(true);
    setFailure(null);
    try { await api.refreshEngines(); await refreshEngines(); } catch (reason) { setFailure(toFailure(reason).message); } finally { setChecking(false); }
  };
  const signIn = engine.sign_in_command && (engine.auth === "logged_out" || engine.tier === "acp");
  return (
    <>
      <div className="set-back">
        <Button small tone="quiet" icon={<ChevronLeft size={13} aria-hidden />} onClick={onBack}>Providers</Button>
        <h2 className="set-back-title">{engine.name}</h2>
        {instance ? <Button small className="set-back-end" onClick={onEdit}>Edit</Button> : null}
      </div>
      {engine.problem ? <SettingsBanner tone="err" actions={<Button small busy={checking} onClick={() => void recheck()}>Check again</Button>}>
        {engine.path ? `Couldn’t run ${engine.path}. ` : ""}{engine.problem}
      </SettingsBanner> : null}
      {failure ? <p className="field-error" role="alert">{failure}</p> : null}
      <SettingGroup>
        <SettingRow title="Version" description={engine.version === null ? "Unknown" : hasNewer ? `${engine.version} · ${engine.latest} is available` : engine.version}>
          <UpdateAction engine={engine} />
          {hasNewer ? null : <Button small busy={checking} onClick={() => void recheck()}>Check for update</Button>}
        </SettingRow>
        <SettingRow title="Login" description={engine.auth === "logged_out" ? "Not signed in" : engine.auth === "logged_in" && engine.account ? `Signed in as ${engine.account}` : authLabels[engine.auth]}>
          {signIn && engine.sign_in_command ? <CopyCommand command={engine.sign_in_command} label="Copy sign-in command" /> : null}
          {engine.auth === "logged_out" ? <Button small busy={checking} onClick={() => void recheck()}>Check again</Button> : null}
        </SettingRow>
        <SettingRow title="Location"><code className="set-path">{engine.path ?? "Not found"}</code></SettingRow>
      </SettingGroup>
      {engine.installed && !engine.update_command && engine.manual_hint && !engine.compatibility ? <p className="setting-line-desc">{engine.manual_hint}</p> : null}
      {engine.installed ? (engine.auth === "logged_out"
        ? <><p className="set-grp">Models</p><div className="set-card"><span className="t3">Sign in to see the models this account can use.</span></div></>
        : <Models engine={engine} />) : null}
      {engine.installed ? <NativeSessions engine={engine} /> : null}
      <SettingGroup>
        {hasFeedback(engine) ? <FeedbackAction engine={engine} /> : null}
        {removable ? (
          <SettingRow title="Remove" description="Removes this instance from Orbyn. Its sign-in and sessions stay with the CLI.">
            <Button small tone="quiet" className="set-remove" aria-label={`Remove ${engine.name}`} onClick={() => setRemoving(true)}>Remove…</Button>
          </SettingRow>
        ) : null}
      </SettingGroup>
      {removing ? (
        <ConfirmDialog title={`Remove ${engine.name}?`} confirmLabel="Remove provider" tone="danger" onClose={() => setRemoving(false)}
          onConfirm={async () => {
            if (instance) {
              const reason = await store.save(patchInstance(store.raw, instance.id, {}).filter((value) => (value as { id?: string }).id !== instance.id));
              if (reason) throw new Error(reason);
            } else await api.removeCustomEngine(engine.id);
            await refreshEngines();
            onBack();
          }}>
          <p>Existing threads keep their log, but can't start new runs with this provider.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
