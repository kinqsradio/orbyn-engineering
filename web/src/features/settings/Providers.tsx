import { RefreshCw, Trash2, ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, request } from "../../api/client";
import type { EngineStatus, JsonValue } from "../../api/types";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import { authLabels, signInLabel, supportLabels, tierLabels } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { arrangeModels, modelKey, useEngineModels, useModelStore } from "../thread/modelStore";
import { Button, CopyCommand, Pill, type PillTone, IconButton } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { AcpRegistry } from "./AcpRegistry";
import { ErrorState, Loading } from "../../ui/states";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProviderInstances } from "./ProviderInstances";
import { HistoryImport } from "./HistoryImport";
import { NativeSessions } from "./NativeSessions";

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
  const advisory = engine.compatibility;
  const recommended = advisory?.recommended_command ? (advisory.recommended_version ?? null) : null;
  if (engine.updating) {
    return (
      <span className="inline-status" role="status">
        <RefreshCw size={16} className="spin" aria-hidden />
        Updating
      </span>
    );
  }
  const hasNewer = engine.latest !== null && engine.latest !== engine.version;
  // A version the signed manifest pushes off is replaced by its recommendation.
  const action = recommended
    ? { label: `Install ${recommended}`, command: advisory?.recommended_command ?? "", install: true }
    : engine.update_command
      ? { label: hasNewer ? `Update to ${engine.latest}` : "Update", command: engine.update_command, install: false }
      : null;
  return (
    <>
      {advisory ? (
        <p className="banner banner-warn" role="status">
          {advisory.message}
        </p>
      ) : null}
      {action ? (
        <Button small onClick={() => setConfirming(true)}>
          {action.label}
        </Button>
      ) : null}
      {advisory?.recommended_version && !recommended ? (
        <p className="muted">
          Install {advisory.recommended_version} with the installer that owns this engine
          {engine.manual_hint ? `. ${engine.manual_hint}` : "."}
        </p>
      ) : null}
      {confirming && action ? (
        <ConfirmDialog
          title={action.install ? `Install ${recommended}?` : `Update ${engine.name}?`}
          confirmLabel={action.install ? `Install ${recommended}` : "Update"}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            if (action.install) await api.installRecommended(engine.id);
            else await api.updateEngine(engine.id);
            await refreshEngines();
          }}
        >
          <p>Orbyn runs the installer that owns this binary:</p>
          <CopyCommand command={action.command} label={action.install ? "Copy install command" : "Copy update command"} />
          <p className="muted">Updates are refused while this engine has an active run.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Which of an engine's models the picker shows, and in what order. */
interface CustomModel {
  engine: string;
  id: string;
  label?: string;
}

function readCustomModel(value: JsonValue): CustomModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.engine !== "string" || typeof value.id !== "string") return null;
  return { engine: value.engine, id: value.id, ...(typeof value.label === "string" ? { label: value.label } : {}) };
}

/** Models the service doesn't list, kept as a setting and merged into its list. */
function CustomModels({ engine }: { engine: EngineStatus }) {
  const scope = useSettingsScope();
  const preferences = useAsync("custom-models", (signal) =>
    request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: {}, keys: ["custom_models"] }, signal),
  );
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const row = preferences.data?.rows.find((entry) => entry.key === "custom_models");
  const all = Array.isArray(row?.value) ? row.value : [];
  const mine = all.flatMap((entry) => {
    const model = readCustomModel(entry);
    return model?.engine === engine.id ? [model] : [];
  });
  const unavailable = scope !== null && (scope.loading || scope.error !== null || !scope.catalog || scope.catalog.selection.kind === "unavailable");
  const disabled = unavailable || busy || preferences.status !== "ready" || preferences.refreshing || !row || !Array.isArray(row.value);
  const save = async (next: JsonValue[]): Promise<boolean> => {
    if (disabled || pending.current || !row || !preferences.data) return false;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const changed = await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", {
        scope: {}, membership_version: preferences.data.catalog.version,
        if_match: { [row.key]: row.revision }, edits: { [row.key]: { op: "set", value: next } },
      });
      preferences.setData(changed);
      void useModelStore.getState().reload(engine.id);
      return true;
    } catch (failure) {
      const reason = toFailure(failure);
      setError(reason.message);
      if (reason.status === 409) { preferences.reload(); scope?.reload(); }
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!id.trim()) return;
    void save([...all, { engine: engine.id, id: id.trim(), ...(label.trim() ? { label: label.trim() } : {}) }]).then((saved) => {
      if (saved) { setId(""); setLabel(""); }
    });
  };
  const visibleError = error ?? preferences.error?.message;
  return (
    <form className="custom-models" aria-label={`Custom models for ${engine.name}`} aria-busy={busy || preferences.refreshing} onSubmit={add}>
      {mine.map((model) => (
        <div key={model.id} className="custom-model">
          <span>{model.label ?? model.id}</span>
          <IconButton
            label={`Remove ${model.label ?? model.id}`}
            disabled={disabled}
            onClick={() => void save(all.filter((entry) => {
              const known = readCustomModel(entry);
              return !(known?.engine === engine.id && known.id === model.id);
            }))}
          >
            <Trash2 size={14} aria-hidden />
          </IconButton>
        </div>
      ))}
      <input aria-label="Model id" placeholder="Model id" disabled={disabled} value={id} onChange={(event) => setId(event.target.value)} />
      <input aria-label="Display name" placeholder="Display name" disabled={disabled} value={label} onChange={(event) => setLabel(event.target.value)} />
      <Button small type="submit" disabled={disabled || !id.trim()}>
        Add model
      </Button>
      {visibleError ? (
        <p className="field-error" role="alert">
          {visibleError}
          {preferences.status === "error" ? <Button small onClick={preferences.reload}>Retry</Button> : null}
        </p>
      ) : null}
    </form>
  );
}

/** Codex is the only driver with a feedback route; an instance runs the same one. */
function hasFeedback(engine: EngineStatus) {
  return engine.id === "codex" || engine.instance_of === "codex";
}

function FeedbackAction({ engine }: { engine: EngineStatus }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [includeLogs, setIncludeLogs] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="setting-sub">
      <Button small tone="quiet" onClick={() => { setError(null); setOpen(true); }}>
        Send feedback
      </Button>
      {receipt ? (
        <p className="banner" role="status">Feedback sent to OpenAI through Codex. Report {receipt}.</p>
      ) : null}
      {open ? (
        <ConfirmDialog
          title={`Send feedback to ${engine.name}?`}
          confirmLabel="Send feedback"
          keepOpen
          onClose={() => setOpen(false)}
          onConfirm={async () => {
            setError(null);
            try {
              const result = await api.sendFeedback(engine.id, {
                reason: reason.trim() || null,
                include_logs: includeLogs,
                thread_id: null,
              });
              setReceipt(result.thread_id);
              setReason("");
              setOpen(false);
            } catch (failure) {
              setError(toFailure(failure).message);
            }
          }}
        >
          <p>This report goes to OpenAI through Codex, using the Codex login on this machine.</p>
          <div className="field">
            <label htmlFor="codex-feedback-reason">What went wrong? (optional)</label>
            <textarea
              id="codex-feedback-reason"
              rows={4}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              role="switch"
              checked={includeLogs}
              onChange={(event) => setIncludeLogs(event.target.checked)}
            />
            Include Codex logs
          </label>
          {includeLogs ? <p className="muted">Codex logs can include prompts, file paths and command output.</p> : null}
          {error ? <p className="banner banner-warn" role="alert">{error}</p> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function EngineModelList({ engine }: { engine: EngineStatus }) {
  const hidden = useUi((state) => state.modelHidden);
  const order = useUi((state) => state.modelOrder);
  const setPrefs = useUi((state) => state.setPrefs);
  const listed = useEngineModels(engine.id);
  const refreshing = useModelStore((state) => state.loading[engine.id] ?? false);
  const error = useModelStore((state) => state.errors[engine.id] ?? null);
  const reload = useModelStore((state) => state.reload);
  const [open, setOpen] = useState(false);
  const models = arrangeModels(engine.id, listed?.models ?? [], [], order);

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
      <Button small tone="quiet" busy={refreshing} onClick={() => void reload(engine.id)} aria-label={`Refresh ${engine.name} models`}>
        Refresh models
      </Button>
      {error ? <p className="banner banner-warn" role="status">Couldn't refresh models. {error}{models.length > 0 ? " Showing the last available list." : " Try refreshing again."}</p> : null}
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
      {open ? <><p className="muted">Custom models are saved on the selected environment.</p><CustomModels engine={engine} /></> : null}
      {hasFeedback(engine) ? <FeedbackAction engine={engine} /> : null}
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
      {!engine.update_command && engine.manual_hint && !engine.compatibility ? <p className="muted">{engine.manual_hint}</p> : null}
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
      ) : (
        <ProviderInstances engines={engines.data} renderBase={(engine) => <NativeSessions engine={engine} />} renderDriver={(engine) => <EngineRow engine={engine} />} renderStatus={(engine) => <>
          {engine.installed ? <Pill tone={supportTone[engine.support]}>{supportLabels[engine.support]}</Pill> : <Pill tone="warn">Not installed</Pill>}
          <dl className="facts"><div><dt>Version</dt><dd>{engine.version ?? "Unknown"}</dd></div><div><dt>Location</dt><dd><code>{engine.path ?? "Not found"}</code></dd></div></dl>
          <UpdateAction engine={engine} />
        </>} renderInstance={(engine) => engine.installed ? <><EngineModelList engine={engine} /><NativeSessions engine={engine} /></> : null} />
      )}
      <HistoryImport />
      <AcpRegistry />
    </>
  );
}
