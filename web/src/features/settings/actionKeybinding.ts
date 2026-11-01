import { useState, type KeyboardEvent } from "react";
import { request } from "../../api/client";
import type { KeybindingsView } from "../../api/types";
import { runHandlers, shortcutForEvent } from "../../app/shortcuts";
import { toFailure, useAsync } from "../../lib/useAsync";
import { actionCommand } from "../../lib/actionCommand";

/** The environment owns shortcuts; an action save and a shortcut save are separate effects. */
export function useActionKeybinding(initialId: string | null) {
  const view = useAsync("action-keybindings", (signal) => request<KeybindingsView>("GET", "/api/keybindings", undefined, signal));
  const [id, setId] = useState(initialId);
  const [draft, setDraft] = useState<string | null>(null);
  const ruleFor = (actionId: string | null) => actionId === null ? undefined
    : [...(view.data?.rules ?? [])].reverse().find((rule) => !rule.remove && rule.command === actionCommand(actionId));
  const value = draft ?? ruleFor(id)?.key ?? "";
  const capture = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Backspace" || event.key === "Delete") { setDraft(""); return; }
    const key = shortcutForEvent(event);
    if (key !== null) setDraft(key);
  };
  const save = async (actionId: string) => {
    setId(actionId);
    if (draft === null) return;
    const previous = ruleFor(actionId);
    if (draft === (previous?.key ?? "")) { setDraft(null); return; }
    const next = await request<KeybindingsView>("POST", "/api/keybindings", {
      command: actionCommand(actionId), key: draft || previous?.key,
      when: previous?.when ?? null, remove: draft === "",
    });
    view.setData(next); setDraft(null);
    runHandlers("keybindings.reload");
  };
  return { value, capture, save, ready: view.status === "ready",
    error: view.status === "error" ? toFailure(view.error).message : view.data?.issues[0] ?? null };
}
