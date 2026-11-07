import { Check, Plus, RefreshCw } from "lucide-react";
import type { EngineStatus } from "../../api/types";
import { Button } from "../../ui/controls";
import type { InstanceStore } from "./ProviderInstances";

/** The status cell: what the person has to do, else that the provider is ready. */
function Status({ engine }: { engine: EngineStatus }) {
  if (!engine.installed) return <span className="set-pill warn">Not installed</span>;
  if (engine.auth === "logged_out" && engine.sign_in_command) return <span className="mono t3">{engine.sign_in_command}</span>;
  if (engine.latest && engine.version && engine.latest !== engine.version) return <span className="set-pill">Update {engine.latest}</span>;
  return <span className="set-pill"><Check size={13} aria-hidden />Ready</span>;
}

const subtitle = (engine: EngineStatus) =>
  engine.tier === "acp" ? "via ACP" : engine.auth === "logged_out" ? "Not signed in" : engine.auth === "logged_in" ? "Signed in" : null;

const COLUMNS = "28px minmax(0, 1fr) 90px 130px 60px 56px";

/** One row per provider and provider instance. A row opens its detail; Edit and In use belong to instances. */
export function ProviderTable({ engines, store, onOpen, onEdit }: {
  engines: EngineStatus[];
  store: InstanceStore;
  onOpen(id: string): void;
  onEdit(id: string): void;
}) {
  return (
    <div className="set-tbl" role="table" aria-label="Providers">
      <div role="row" className="set-tr h" style={{ gridTemplateColumns: COLUMNS }}>
        <span /><span role="columnheader">Provider</span><span role="columnheader">Version</span><span role="columnheader">Status</span><span /><span role="columnheader">In use</span>
      </div>
      {engines.map((engine) => {
        const note = subtitle(engine);
        const instance = store.instances.find((entry) => entry.id === engine.id);
        return (
          <div key={engine.id} role="row" className="set-tr set-tr-open" style={{ gridTemplateColumns: COLUMNS }} onClick={() => onOpen(engine.id)}>
            <span role="cell"><span className="set-mark" style={engine.accent ? { background: engine.accent, color: "#fff" } : undefined}>{engine.name.charAt(0).toUpperCase()}</span></span>
            <span role="cell">
              <button type="button" className="set-row-open name" onClick={(event) => { event.stopPropagation(); onOpen(engine.id); }}>{engine.name}</button>
              {note ? <><br /><span className="sub">{note}</span></> : null}
            </span>
            <span role="cell" className="t3">{engine.version ?? ""}</span>
            <span role="cell"><Status engine={engine} /></span>
            <span role="cell">{instance ? <Button small aria-label={`Edit ${engine.name}`} onClick={(event) => { event.stopPropagation(); onEdit(engine.id); }}>Edit</Button> : null}</span>
            <span role="cell" onClick={(event) => event.stopPropagation()}>
              {instance ? <input type="checkbox" role="switch" aria-label={`Enable ${engine.name}`} checked={instance.enabled} disabled={store.disabled}
                onChange={(event) => store.setEnabled(instance.id, event.target.checked)} /> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ProviderListActions({ onAdd, onRecheck, checking }: { onAdd(): void; onRecheck(): void; checking: boolean }) {
  return (
    <div className="set-tools">
      <Button small onClick={onAdd}><Plus size={13} aria-hidden />Add provider</Button>
      <Button small busy={checking} onClick={onRecheck}><RefreshCw size={13} aria-hidden />Check again</Button>
    </div>
  );
}
