import { useState } from "react";
import { request } from "../../api/client";
import type { AcpRegistryEntry } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";

const q = encodeURIComponent;

const LABELS: Record<string, string> = { binary: "Binary", npx: "npx", uvx: "uvx" };

/** Finds agents in the public ACP registry. It is read only when someone searches. */
export function AcpRegistry() {
  const [text, setText] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const pushToast = useUi((state) => state.pushToast);
  const found = useAsync(`acp-registry:${query ?? ""}`, (signal) =>
    query === null
      ? Promise.resolve([])
      : request<AcpRegistryEntry[]>("GET", `/api/acp/registry?q=${q(query)}`, undefined, signal),
  );
  const act = async (entry: AcpRegistryEntry, work: Promise<unknown>, done: string) => {
    setWorking(entry.id);
    try {
      await work;
      await refreshEngines();
      found.reload();
      pushToast(done);
    } catch (failure) {
      pushToast(`Couldn't change ${entry.name}. ${toFailure(failure).message}`);
    } finally {
      setWorking(null);
    }
  };
  const install = (entry: AcpRegistryEntry) =>
    void act(
      entry,
      request("POST", `/api/acp/registry/${q(entry.id)}`, { distribution: entry.installable[0] }),
      `${entry.name} added`,
    );
  const remove = (entry: AcpRegistryEntry) =>
    void act(entry, request("DELETE", `/api/acp/registry/${q(entry.id)}`), `${entry.name} removed`);

  return (
    <section className="form setting-form" aria-label="ACP registry">
      <h3>ACP registry</h3>
      <form
        className="acp-search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(text.trim());
        }}
      >
        <input
          type="search"
          aria-label="Search the ACP registry"
          placeholder="Search the ACP registry"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button small type="submit">
          Search
        </Button>
      </form>
      {query === null ? null : found.status === "loading" ? (
        <Loading label="Searching the registry" rows={2} />
      ) : found.status === "error" ? (
        <ErrorState compact title="Couldn't read the registry" failure={found.error} onRetry={found.reload} />
      ) : found.data.length === 0 ? (
        <p className="muted">No agents found</p>
      ) : (
        <ul className="acp-results">
          {found.data.map((entry) => (
            <li key={entry.id}>
              <div>
                <strong>{entry.name}</strong> <span className="muted">{entry.version}</span>
                <p className="muted">{entry.description}</p>
              </div>
              {entry.engine ? (
                <Button small tone="quiet" disabled={working === entry.id} onClick={() => remove(entry)}>
                  Remove {entry.name}
                </Button>
              ) : entry.installable.length > 0 ? (
                <Button small disabled={working === entry.id} onClick={() => install(entry)}>
                  Add through {LABELS[entry.installable[0] ?? ""] ?? entry.installable[0]}
                </Button>
              ) : (
                <span className="muted">Can't be installed here</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
