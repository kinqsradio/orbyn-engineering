import { Check, Plug, Plus } from "lucide-react";
import type { EngineStatus } from "../../api/types";
import { Button } from "../../ui/controls";

/** The status cell: what the person has to do, else that the provider is ready. */
function Status({ engine }: { engine: EngineStatus }) {
  if (!engine.installed) return <span className="set-pill warn">Not installed</span>;
  if (engine.auth === "logged_out" && engine.sign_in_command) return <span className="mono t3">{engine.sign_in_command}</span>;
  if (engine.latest && engine.version && engine.latest !== engine.version) return <span className="set-pill">Update {engine.latest}</span>;
  return <span className="set-pill"><Check size={13} aria-hidden />Ready</span>;
}

const subtitle = (engine: EngineStatus) =>
  engine.tier === "acp" ? "via ACP" : engine.auth === "logged_out" ? "Not signed in" : engine.auth === "logged_in" ? "Signed in" : null;

/** One row per provider and provider instance, with the two ways to add one. */
export function ProviderTable({ engines, onEdit, onAdd, onRegistry }: {
  engines: EngineStatus[];
  onEdit(id: string): void;
  onAdd(): void;
  onRegistry(): void;
}) {
  return (
    <>
      <div className="set-tbl" role="table" aria-label="Providers">
        {engines.map((engine) => {
          const note = subtitle(engine);
          return (
            <div key={engine.id} role="row" className="set-tr" style={{ gridTemplateColumns: "28px minmax(0, 1fr) 150px 130px 70px" }}>
              <span role="cell"><span className="set-mark" style={engine.accent ? { background: engine.accent, color: "#fff" } : undefined}>{engine.name.charAt(0).toUpperCase()}</span></span>
              <span role="cell"><span className="name">{engine.name}</span>{note ? <><br /><span className="sub">{note}</span></> : null}</span>
              <span role="cell" className="t3">{engine.version ?? ""}</span>
              <span role="cell"><Status engine={engine} /></span>
              <span role="cell"><Button small aria-label={`Edit ${engine.name}`} onClick={() => onEdit(engine.id)}>Edit</Button></span>
            </div>
          );
        })}
      </div>
      <div className="set-tools">
        <Button small onClick={onAdd}><Plus size={13} aria-hidden />Add an instance</Button>
        <Button small onClick={onRegistry}><Plug size={13} aria-hidden />ACP registry</Button>
      </div>
    </>
  );
}
