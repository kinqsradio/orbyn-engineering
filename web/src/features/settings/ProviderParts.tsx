import { RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { api, request } from "../../api/client";
import type { EngineStatus, JsonValue } from "../../api/types";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { useModelStore } from "../../state/modelStore";
import { Button, CopyCommand, type PillTone } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { SettingRow } from "../../ui/SettingRow";
import { useSettingsScope } from "./SettingsScopeContext";
import { useEngineUpdates, UpdateProgressLine } from "./engineUpdates";

export const supportTone: Record<EngineStatus["support"], PillTone> = {
  tested: "neutral",
  untested: "info",
  below_minimum: "danger",
  unknown: "neutral",
};

export function UpdateAction({ engine }: { engine: EngineStatus }) {
  const [confirming, setConfirming] = useState(false);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const advisory = engine.compatibility;
  const recommended = advisory?.recommended_command ? (advisory.recommended_version ?? null) : null;
  const running = useEngineUpdates((state) => engine.id in state.running);
  // An open dialog stays open: it holds the update's own outcome and error.
  if ((engine.updating || running) && !confirming) {
    return (
      <>
        <span className="inline-status" role="status">
          <RefreshCw size={16} className="spin" aria-hidden />
          Updating
        </span>
        <UpdateProgressLine engine={engine.id} />
      </>
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
          <UpdateProgressLine engine={engine.id} />
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
export function useCustomModels(engine: EngineStatus) {
  const scope = useSettingsScope();
  const preferences = useAsync("custom-models", (signal) =>
    request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: {}, keys: ["custom_models"] }, signal),
  );
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
      useUi.getState().bumpPreferencesRevision();
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
  return {
    mine, disabled, busy, retry: preferences.status === "error" ? preferences.reload : null,
    error: error ?? preferences.error?.message ?? null,
    add: (id: string, label: string) => save([...all, { engine: engine.id, id: id.trim(), ...(label.trim() ? { label: label.trim() } : {}) }]),
    remove: (id: string) => save(all.filter((entry) => {
      const known = readCustomModel(entry);
      return !(known?.engine === engine.id && known.id === id);
    })),
  };
}

/** Codex is the only driver with a feedback route; an instance runs the same one. */
export function hasFeedback(engine: EngineStatus) {
  return engine.id === "codex" || engine.instance_of === "codex";
}

export function FeedbackAction({ engine }: { engine: EngineStatus }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [includeLogs, setIncludeLogs] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <SettingRow title="Send feedback" description="About this provider in Orbyn">
        <Button small aria-label="Send feedback" onClick={() => { setError(null); setOpen(true); }}>
          Open
        </Button>
      </SettingRow>
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
    </>
  );
}

