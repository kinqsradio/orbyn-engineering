import { useState } from "react";
import { request } from "../../api/client";
import type { KeybindingsView } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { Button } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";

const load = (signal?: AbortSignal) => request<KeybindingsView>("GET", "/api/keybindings", undefined, signal);

export function KeybindingsSection() {
  const view = useAsync("keybindings", load);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const capture = (event: React.KeyboardEvent, command: string, when: string | null) => {
    if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setEditing(null);
      return;
    }
    const key = [
      event.metaKey || event.ctrlKey ? "mod" : null,
      event.altKey ? "alt" : null,
      event.shiftKey ? "shift" : null,
      event.key.toLowerCase(),
    ]
      .filter(Boolean)
      .join("+");
    setEditing(null);
    request<KeybindingsView>("POST", "/api/keybindings", { key, command, when, remove: false }).then(
      view.setData,
      (failure: unknown) => setError(toFailure(failure).message),
    );
  };

  return (
    <>
      <h1 className="sr-only" tabIndex={-1} data-page-title>
        Keybindings
      </h1>
      <input
        aria-label="Filter keybindings"
        placeholder="Search keybindings"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {view.status === "loading" ? (
        <Loading label="Loading keybindings" rows={6} />
      ) : view.status === "error" ? (
        <ErrorState title="Couldn't load keybindings" failure={view.error} onRetry={view.reload} />
      ) : (
        <>
          {view.data.issues.map((issue) => (
            <p key={issue} className="banner banner-warn">
              {issue}
            </p>
          ))}
          {view.data.conflicts.map((conflict) => (
            <p key={`${conflict.key}:${conflict.when ?? ""}`} className="banner banner-warn">
              {conflict.key} is used by {conflict.commands.join(", ")}
            </p>
          ))}
          <table className="keys-table">
            <thead>
              <tr>
                <th>Command</th>
                <th>Key</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {view.data.rules
                .filter((rule) => !rule.remove && `${rule.command} ${rule.key}`.includes(filter.toLowerCase()))
                .map((rule) => {
                  const id = `${rule.command}:${rule.key}:${rule.when ?? ""}`;
                  return (
                    <tr key={id}>
                      <td>{rule.command}</td>
                      <td>
                        <Button
                          small
                          tone="quiet"
                          onClick={() => setEditing(id)}
                          onKeyDown={editing === id ? (event) => capture(event, rule.command, rule.when) : undefined}
                        >
                          {editing === id ? "Press keys…" : rule.key}
                        </Button>
                      </td>
                      <td>{rule.when ?? ""}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <p className="muted">{view.data.path}</p>
        </>
      )}
    </>
  );
}
