import { useState } from "react";
import { request } from "../../api/client";
import { inDesktopApp } from "../../api/shell";
import { formatShortcut, runHandlers } from "../../app/shortcuts";
import type { KeybindingsView } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { Pencil, Search } from "lucide-react";
import { IconButton } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";

/** Names the frames give commands. A command with no name here shows its id. */
const COMMAND_LABELS: Record<string, string> = {
  "thread.new": "New thread",
  "commandPalette.toggle": "Command palette",
  "threadPanel.toggle": "Toggle side panel",
  "terminal.toggle": "Toggle terminal",
  "approval.allow": "Allow the waiting command",
  "thread.nextNeedsYou": "Next thread that needs you",
  "chat.find": "Find in thread",
  "thread.archive": "Archive thread",
};
const CAP_GLYPHS: Record<string, string> = { Enter: "↵", Backspace: "⌫" };
const commandLabel = (command: string) => COMMAND_LABELS[command] ?? command;

/** One key cap per key: ⌘ ⇧ B on a Mac, Ctrl Shift B elsewhere. */
function keyCaps(rule: string): string[] {
  const text = formatShortcut(rule);
  const mac = text.match(/^([⌘⌃⌥⇧]+)(.+)$/);
  const parts = mac ? [...Array.from(mac[1] ?? ""), mac[2] ?? ""] : text.includes("+") ? text.split(/\+(?=.)/) : [text];
  return parts.map((part) => CAP_GLYPHS[part] ?? part);
}

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
      (next) => {
        view.setData(next);
        runHandlers("keybindings.reload");
      },
      (failure: unknown) => setError(toFailure(failure).message),
    );
  };

  return (
    <>
      <h1 className="sr-only" tabIndex={-1} data-page-title>
        Keybindings
      </h1>
      <label className="set-find">
        <Search size={13} aria-hidden />
        <input aria-label="Filter keybindings" placeholder="Find a shortcut" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      <p className="setting-line-desc">
        {inDesktopApp()
          ? `${formatShortcut("mod+w")} is reserved: it never closes the window.`
          : `A browser closes the tab on ${formatShortcut("mod+w")}, so its bindings here also answer to ${formatShortcut("alt+w")}.`}
      </p>
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
          <div className="set-tbl" role="table" aria-label="Keybindings">
            {view.data.rules
              .filter((rule) => !rule.remove && `${commandLabel(rule.command)} ${rule.command} ${rule.key}`.toLowerCase().includes(filter.toLowerCase()))
              .map((rule) => {
                const id = `${rule.command}:${rule.key}:${rule.when ?? ""}`;
                const clash = view.data.conflicts.find((conflict) => conflict.key === rule.key && (conflict.when ?? "") === (rule.when ?? "") && conflict.commands.includes(rule.command));
                const others = clash?.commands.filter((command) => command !== rule.command).map(commandLabel).join(", ");
                return (
                  <div key={id} role="row" className="set-tr" style={{ gridTemplateColumns: "minmax(0, 1fr) 180px 130px" }}>
                    <span role="cell">{commandLabel(rule.command)}</span>
                    <span role="cell">
                      {editing === id ? <button type="button" className="btn btn-small" onKeyDown={(event) => capture(event, rule.command, rule.when)} ref={(element) => element?.focus()}>Press keys…</button>
                        : <span className="keycaps" aria-label={formatShortcut(rule.key)}>{keyCaps(rule.key).map((cap, at) => <span key={at} className={clash ? "kc warn" : "kc"} aria-hidden>{cap}</span>)}</span>}
                    </span>
                    <span role="cell">
                      {clash ? <span className="set-clash">Clashes with {others}</span>
                        : <IconButton label={`Change shortcut for ${commandLabel(rule.command)}`} onClick={() => setEditing(id)}><Pencil size={13} aria-hidden /></IconButton>}
                    </span>
                  </div>
                );
              })}
          </div>
          <p className="muted">{view.data.path}</p>
        </>
      )}
    </>
  );
}
