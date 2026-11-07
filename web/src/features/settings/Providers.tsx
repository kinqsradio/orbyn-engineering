import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { EngineUpdateOutcome } from "../../generated/EngineUpdateOutcome";
import type { EngineStatus } from "../../api/types";
import type { ProviderInstance } from "../../generated/ProviderInstance";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useConnection } from "../../state/connection";
import { useWorkspace } from "../../state/workspace";
import { Button, CopyCommand } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { SettingRow } from "../../ui/SettingRow";
import { ErrorState, Loading } from "../../ui/states";
import { AddProviderDialog, InstanceEditor, useProviderInstances } from "./ProviderInstances";
import { ProviderDetail } from "./ProviderDetail";
import { AcpRegistryPage, HistoryImportPage } from "./ProviderPages";
import { ProviderListActions, ProviderTable } from "./ProviderTable";
import { SettingsBanner } from "./SettingsBanner";
import { followEngineUpdates, UpdateProgressLine } from "./engineUpdates";

const POLL_WHILE_UPDATING_MS = 1500;

/** An engine the service's update-all takes: owned, newer, not an instance, no signed warning. */
function wantsUpdate(engine: EngineStatus) {
  return !engine.instance_of && !!engine.update_command && !engine.compatibility
    && engine.latest !== null && engine.latest !== engine.version;
}

type View = { page: "list" } | { page: "detail"; id: string } | { page: "history" } | { page: "registry" };

/** How many conversations Claude and Codex keep on this computer, as the service counts them. Hidden until it answers, and when there are none. */
function NativeSessionsRow({ engines, onReview }: { engines: EngineStatus[]; onReview(): void }) {
  const ids = ["claude", "codex"].filter((id) => engines.some((engine) => engine.id === id));
  const counts = useAsync(`native-session-counts:${ids.join()}`, async (signal) => {
    // One engine that cannot count must not hide the others.
    const settled = await Promise.allSettled(ids.map((id) => api.nativeSessionCount(id, signal)));
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
  });
  if (counts.status !== "ready") return null;
  const total = counts.data.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return null;
  return (
    <SettingRow title="Native sessions" description="Provider sessions this computer keeps">
      <Button small onClick={onReview}>Review {total}{counts.data.some((entry) => entry.truncated) ? "+" : ""}</Button>
    </SettingRow>
  );
}

export function ProvidersSection() {
  const engines = useWorkspace((state) => state.engines);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const store = useProviderInstances();
  const offline = useConnection((state) => state.offline);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updating = engines.data?.some((engine) => engine.updating) ?? false;
  const updatable = (engines.data ?? []).filter(wantsUpdate);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [outcomes, setOutcomes] = useState<EngineUpdateOutcome[] | null>(null);
  const [view, setView] = useState<View>({ page: "list" });
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState<{ instance: ProviderInstance; program: string; title: string } | null>(null);
  const checkedAt = useRef<number | null>(null);
  if (engines.data && !offline) checkedAt.current = Date.now();

  useEffect(() => followEngineUpdates(), []);
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
  const list = () => setView({ page: "list" });
  const base = (engines.data ?? []).filter((engine) => !engine.instance_of);
  const editInstance = store.instances.find((entry) => entry.id === editing);

  if (view.page === "history") return <HistoryImportPage onBack={list} />;
  if (view.page === "registry") return <AcpRegistryPage onBack={list} />;
  const detail = view.page === "detail" ? engines.data?.find((engine) => engine.id === view.id) : undefined;
  if (detail) {
    return (
      <>
        <ProviderDetail engine={detail} store={store} onBack={list} onEdit={() => setEditing(detail.id)} />
        {editInstance ? <InstanceEditor store={store} engines={base} instance={editInstance} onClose={() => setEditing(null)} /> : null}
      </>
    );
  }

  return (
    <>
      <div className="section-bar">
        <h1 className="sr-only" tabIndex={-1} data-page-title>
          Providers
        </h1>
        {updatable.length > 1 && !updating ? (
          <Button small onClick={() => setConfirmingAll(true)}>
            Update all
          </Button>
        ) : null}
      </div>
      {confirmingAll ? (
        <ConfirmDialog
          title={`Update ${updatable.length} providers?`}
          confirmLabel="Update all"
          onClose={() => setConfirmingAll(false)}
          onConfirm={async () => {
            setOutcomes(await api.updateAllEngines());
            await refreshEngines();
          }}
        >
          <p>Orbyn runs the installer that owns each binary, one at a time:</p>
          {updatable.map((engine) => (
            <CopyCommand key={engine.id} command={engine.update_command ?? ""} label={`Copy ${engine.name} update command`} />
          ))}
          <p className="muted">A provider with an active run is skipped and reported.</p>
          <UpdateProgressLine />
        </ConfirmDialog>
      ) : null}
      {outcomes?.some((outcome) => outcome.error) ? (
        <ul className="field-error" role="alert">
          {outcomes.filter((outcome) => outcome.error).map((outcome) => (
            <li key={outcome.id}>{outcome.name}: {outcome.error}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {store.error || store.conflict ? (
        <p className="field-error" role="alert">{store.error ?? "Settings changed. Reload before saving."} <Button small disabled={store.disabled && !store.conflict} onClick={store.reload}>Reload</Button></p>
      ) : null}
      {offline ? (
        <SettingsBanner actions={<Button small busy={refreshing} onClick={() => void recheck()}>Check again</Button>}>
          You’re offline. Versions and sign-ins are from the last check{checkedAt.current !== null ? ` at ${new Date(checkedAt.current).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}.
        </SettingsBanner>
      ) : null}
      {engines.error && !engines.data ? (
        <ErrorState title="Couldn't load providers" failure={engines.error} onRetry={() => void refreshEngines()} />
      ) : !engines.data ? (
        <Loading label="Loading providers" />
      ) : engines.data.length === 0 ? (
        <div className="empty">
          <h4 className="empty-title">No providers yet</h4>
          <p>Add an agent installation to start threads.</p>
          <span className="set-tools">
            <Button tone="primary" small onClick={() => setAdding(true)}>Add provider</Button>
            <Button small onClick={() => setView({ page: "registry" })}>ACP registry</Button>
          </span>
        </div>
      ) : (<>
        <ProviderTable engines={engines.data} store={store} onOpen={(id) => setView({ page: "detail", id })} onEdit={setEditing} />
        <ProviderListActions onAdd={() => setAdding(true)} onRecheck={() => void recheck()} checking={refreshing} />
        <SettingRow title="Agent history import" description="Bring in sessions you ran in Claude Code or Codex outside Orbyn">
          <Button small onClick={() => setView({ page: "history" })}>Import…</Button>
        </SettingRow>
        <NativeSessionsRow engines={engines.data} onReview={() => setView({ page: "history" })} />
        <SettingRow title="ACP registry" description="Add other agents that speak ACP">
          <Button small onClick={() => setView({ page: "registry" })}>Browse</Button>
        </SettingRow>
      </>)}
      {editInstance ? <InstanceEditor store={store} engines={base} instance={editInstance} onClose={() => setEditing(null)} /> : null}
      {adding ? (
        <AddProviderDialog engines={engines.data ?? []} onClose={() => setAdding(false)}
          onRegistry={() => { setAdding(false); setView({ page: "registry" }); }}
          onChosen={(choice) => {
            setAdding(false);
            const driver = choice === "_local_acp" ? "_local_acp" : choice.id;
            setCreating({ instance: { id: "", driver, enabled: true }, program: choice === "_local_acp" ? "" : choice.path ?? "",
              title: choice === "_local_acp" ? "Add a local ACP command" : `Add ${choice.name}` });
          }} />
      ) : null}
      {creating ? (
        <InstanceEditor store={store} engines={base} instance={creating.instance} create={{ program: creating.program, title: creating.title }}
          onClose={() => setCreating(null)} onSaved={(saved) => setView({ page: "detail", id: saved.id })} />
      ) : null}
    </>
  );
}
