import { RefreshCw, Trash2, ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { EngineStatus, EngineTier } from "../../api/types";
import { authLabels, signInLabel, slugify, supportLabels, tierLabels } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { arrangeModels, modelKey, useEngineModels } from "../thread/modelStore";
import { Button, CopyCommand, Field, Pill, type PillTone, IconButton } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { AcpRegistry } from "./AcpRegistry";
import { Empty, ErrorState, Loading } from "../../ui/states";

const POLL_WHILE_UPDATING_MS = 1500;

const supportTone: Record<EngineStatus["support"], PillTone> = {
  tested: "neutral",
  untested: "info",
  below_minimum: "danger",
  unknown: "neutral",
};

function UpdateAction({ engine }: { engine: EngineStatus }) {
  const [confirming, setConfirming] = useState(false);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  if (engine.updating) {
    return (
      <span className="inline-status" role="status">
        <RefreshCw size={16} className="spin" aria-hidden />
        Updating
      </span>
    );
  }
  if (!engine.update_command) return null;
  const hasNewer = engine.latest !== null && engine.latest !== engine.version;
  return (
    <>
      <Button small onClick={() => setConfirming(true)}>
        {hasNewer ? `Update to ${engine.latest}` : "Update"}
      </Button>
      {confirming ? (
        <ConfirmDialog
          title={`Update ${engine.name}?`}
          confirmLabel="Update"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await api.updateEngine(engine.id);
            await refreshEngines();
          }}
        >
          <p>Orbyn runs the installer that owns this binary:</p>
          <CopyCommand command={engine.update_command} label="Copy update command" />
          <p className="muted">Updates are refused while this engine has an active run.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Which of an engine's models the picker shows, and in what order. */
function EngineModelList({ engine }: { engine: EngineStatus }) {
  const hidden = useUi((state) => state.modelHidden);
  const order = useUi((state) => state.modelOrder);
  const setPrefs = useUi((state) => state.setPrefs);
  const listed = useEngineModels(engine.id);
  const [open, setOpen] = useState(false);
  const models = arrangeModels(engine.id, listed?.models ?? [], [], order);
  if (models.length === 0) return null;

  const move = (at: number, step: number) => {
    const keys = models.map((model) => modelKey(engine.id, model.id));
    const [key] = keys.splice(at, 1);
    if (!key) return;
    keys.splice(at + step, 0, key);
    setPrefs({ modelOrder: [...order.filter((entry) => !keys.includes(entry)), ...keys] });
  };

  return (
    <div className="setting-sub">
      <button type="button" className="text-action" aria-expanded={open} onClick={() => setOpen(!open)}>
        Models ({models.length})
      </button>
      {open ? (
        <ul className="model-settings">
          {models.map((model, at) => {
            const key = modelKey(engine.id, model.id);
            const shown = !hidden.includes(key);
            return (
              <li key={model.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={shown}
                    onChange={() =>
                      setPrefs({
                        modelHidden: shown ? [...hidden, key] : hidden.filter((entry) => entry !== key),
                      })
                    }
                  />
                  <span>{model.label}</span>
                </label>
                <IconButton label={`Move ${model.label} up`} disabled={at === 0} onClick={() => move(at, -1)}>
                  <ArrowUp size={14} aria-hidden />
                </IconButton>
                <IconButton
                  label={`Move ${model.label} down`}
                  disabled={at === models.length - 1}
                  onClick={() => move(at, 1)}
                >
                  <ArrowDown size={14} aria-hidden />
                </IconButton>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function EngineRow({ engine }: { engine: EngineStatus }) {
  const [removing, setRemoving] = useState(false);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const removable = engine.tier !== "native";
  return (
    <li className="setting-row">
      <div className="engine-row-head">
        <h3>{engine.name}</h3>
        <Pill>{tierLabels[engine.tier]}</Pill>
        {!engine.capabilities.managed ? <span className="muted">Unmanaged</span> : null}
        {engine.installed ? (
          <Pill tone={supportTone[engine.support]}>{supportLabels[engine.support]}</Pill>
        ) : (
          <Pill tone="warn">Not installed</Pill>
        )}
        <span className="engine-row-actions">
          <UpdateAction engine={engine} />
          {removable ? (
            <Button
              small
              tone="quiet"
              aria-label={`Remove ${engine.name}`}
              icon={<Trash2 size={16} aria-hidden />}
              onClick={() => setRemoving(true)}
            />
          ) : null}
        </span>
      </div>
      <dl className="facts">
        <div>
          <dt>Version</dt>
          <dd>{engine.version ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Login</dt>
          <dd>{authLabels[engine.auth]}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>
            <code>{engine.path ?? "Not found"}</code>
          </dd>
        </div>
      </dl>
      {engine.problem ? <p className="banner banner-warn">{engine.problem}</p> : null}
      {engine.installed ? <EngineModelList engine={engine} /> : null}
      {engine.auth === "logged_out" ? (
        <div className="setting-sub">
          <p>{signInLabel(engine)}. Run this in a terminal:</p>
          {engine.sign_in_command ? (
            <CopyCommand command={engine.sign_in_command} label="Copy sign-in command" />
          ) : null}
        </div>
      ) : null}
      {!engine.update_command && engine.manual_hint ? <p className="muted">{engine.manual_hint}</p> : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${engine.name}?`}
          confirmLabel="Remove engine"
          tone="danger"
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            await api.removeCustomEngine(engine.id);
            await refreshEngines();
          }}
        >
          <p>Existing threads keep their log, but can't start new runs with this engine.</p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

const CUSTOM_TIERS: { tier: EngineTier; target: string; hint: string }[] = [
  { tier: "acp", target: "Launch command", hint: "The command that starts an ACP agent over stdio." },
  { tier: "agui", target: "Endpoint URL", hint: "The AG-UI endpoint Orbyn connects to." },
  { tier: "terminal", target: "Launch command", hint: "Runs in a terminal only and is always unmanaged." },
];

function CustomEngineForm() {
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const [name, setName] = useState("");
  const [tier, setTier] = useState<EngineTier>("acp");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = CUSTOM_TIERS.find((entry) => entry.tier === tier) ?? CUSTOM_TIERS[0];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addCustomEngine({
        id: slugify(name),
        name: name.trim(),
        tier,
        target: target.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
      });
      await refreshEngines();
      setName("");
      setTarget("");
      setArgs("");
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form setting-form" onSubmit={(event) => void submit(event)}>
      <h3>Add provider</h3>
      <div className="form-grid">
        <Field label="Name">
          {(props) => <input {...props} required value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label="Protocol">
          {(props) => (
            <select {...props} value={tier} onChange={(event) => setTier(event.target.value as EngineTier)}>
              {CUSTOM_TIERS.map((entry) => (
                <option key={entry.tier} value={entry.tier}>
                  {tierLabels[entry.tier]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label={copy?.target ?? "Target"} hint={copy?.hint}>
        {(props) => (
          <input
            {...props}
            required
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
        )}
      </Field>
      {tier === "agui" ? null : (
        <Field label="Arguments (optional)">
          {(props) => (
            <input
              {...props}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
          )}
        </Field>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button type="submit" busy={busy} disabled={!name.trim() || !target.trim()}>
          Add provider
        </Button>
      </div>
    </form>
  );
}

export function ProvidersSection() {
  const engines = useWorkspace((state) => state.engines);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updating = engines.data?.some((engine) => engine.updating) ?? false;

  useEffect(() => {
    if (!updating) return;
    const timer = setInterval(() => void refreshEngines(), POLL_WHILE_UPDATING_MS);
    return () => clearInterval(timer);
  }, [updating, refreshEngines]);

  const recheck = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await api.refreshEngines();
      await refreshEngines();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="section-bar">
        <h1 className="sr-only" tabIndex={-1} data-page-title>
          Providers
        </h1>
        <Button small busy={refreshing} onClick={() => void recheck()}>
          Check again
        </Button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {engines.error && !engines.data ? (
        <ErrorState title="Couldn't load providers" failure={engines.error} onRetry={() => void refreshEngines()} />
      ) : !engines.data ? (
        <Loading label="Loading providers" />
      ) : engines.data.length === 0 ? (
        <Empty title="No providers found" />
      ) : (
        <ul className="setting-list">
          {engines.data.map((engine) => (
            <EngineRow key={engine.id} engine={engine} />
          ))}
        </ul>
      )}
      <AcpRegistry />
      <CustomEngineForm />
    </>
  );
}
