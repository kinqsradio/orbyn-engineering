import { useEffect, useRef } from "react";
import type { KeybindingRule } from "../api/types";
import { inDesktopApp } from "../api/shell";
import { actionIdFromCommand } from "../lib/actionCommand";

/** Handlers live with what they act on, and register while mounted. */
type CommandHandler = { run(argument?: string): boolean | void; available(argument?: string): boolean };
const handlers = new Map<string, Set<CommandHandler>>();

const hasHandler = (command: string, argument?: string) =>
  [...(handlers.get(command) ?? [])].some((handler) => handler.available(argument));

export function runHandlers(command: string, argument?: string): boolean {
  let handled = false;
  for (const handler of handlers.get(command) ?? []) {
    if (handler.available(argument) && handler.run(argument) !== false) handled = true;
  }
  return handled;
}

export function useCommand(command: string, handler: (argument?: string) => boolean | void, available: (argument?: string) => boolean = () => true) {
  const latest = useRef({ handler, available });
  useEffect(() => {
    latest.current = { handler, available };
  });
  useEffect(() => {
    const call: CommandHandler = { run: (argument) => latest.current.handler(argument), available: (argument) => latest.current.available(argument) };
    const set = handlers.get(command) ?? new Set();
    handlers.set(command, set);
    set.add(call);
    return () => {
      set.delete(call);
    };
  }, [command]);
}

const mac = () => /mac/i.test(navigator.platform);
const SHIFTED_CODE = /^(Digit|Bracket)/;

type ShortcutEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const eventKey = (event: ShortcutEvent): string => {
  if (event.key === " ") return "space";
  if (event.key === "Escape") return "esc";
  // Shift changes the character, so the physical key names these.
  if (event.shiftKey && SHIFTED_CODE.test(event.code)) {
    if (event.code === "BracketLeft") return "[";
    if (event.code === "BracketRight") return "]";
    return event.code.slice(5);
  }
  return event.key.toLowerCase();
};

export function shortcutForEvent(event: ShortcutEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  return [
    (mac() ? event.metaKey : event.ctrlKey) ? "mod" : null,
    mac() && event.ctrlKey ? "ctrl" : null,
    !mac() && event.metaKey ? "meta" : null,
    event.altKey ? "alt" : null, event.shiftKey ? "shift" : null,
    eventKey(event),
  ].filter(Boolean).join("+");
}

export function matchesKey(rule: string, event: KeyboardEvent): boolean {
  const parts = rule.toLowerCase().split(/\+(?=.)/);
  const key = parts.pop();
  const has = (name: string) => parts.includes(name);
  const wantsMeta = (has("mod") && mac()) || has("meta") || has("cmd");
  const wantsCtrl = (has("mod") && !mac()) || has("ctrl");
  return (
    event.metaKey === wantsMeta &&
    event.ctrlKey === wantsCtrl &&
    event.altKey === has("alt") &&
    event.shiftKey === has("shift") &&
    (key === "escape" ? "esc" : key) === eventKey(event)
  );
}

/**
 * `mod+w` is reserved. In the desktop app the page always takes it, so it never
 * closes the window; a browser closes the tab before the page hears it, so there a
 * `mod+w` rule also answers to the same key with `alt` in place of `mod`.
 */
export const isCloseKey = (rule: string) => {
  const parts = rule.toLowerCase().split(/\+(?=.)/);
  return parts.pop() === "w" && parts.includes("mod");
};

export function browserAlternate(rule: string): string | null {
  if (!isCloseKey(rule)) return null;
  const parts = rule.toLowerCase().split(/\+(?=.)/);
  const key = parts.pop();
  const rest = parts.filter((part) => part !== "mod" && part !== "alt");
  return ["alt", ...rest, key].join("+");
}

/** A rule's key, or its browser alternate outside the desktop app. */
export function ruleMatches(rule: string, event: KeyboardEvent, desktop: boolean): boolean {
  if (matchesKey(rule, event)) return true;
  const alternate = desktop ? null : browserAlternate(rule);
  return alternate !== null && matchesKey(alternate, event);
}

/** The reserved close key itself, as pressed. */
export const isReservedCloseEvent = (event: KeyboardEvent) => matchesKey("mod+w", event) || matchesKey("mod+shift+w", event);

export type WhenContext = Record<string, boolean>;

let terminalRules: KeybindingRule[] = [];
let terminalContext: () => WhenContext = () => ({ terminalFocus: true, editableFocus: true });

/** Reservation and dispatch must agree before a terminal yields a key to the app. */
export function actionShortcutAllowed(event: KeyboardEvent, context: WhenContext): boolean {
  return !event.repeat && !event.isComposing && !context.dialogOpen
    && Boolean(event.metaKey || event.ctrlKey || event.altKey || !context.editableFocus);
}

/** Keeps the rules that act inside a terminal, which reads the keyboard itself. */
export function setTerminalRules(rules: KeybindingRule[], context: () => WhenContext = () => ({ terminalFocus: true, editableFocus: true })) {
  terminalContext = context;
  terminalRules = rules.filter((rule) => !rule.remove && (/(^|[^!])terminalFocus/.test(rule.when ?? "")
    || actionIdFromCommand(rule.command) !== null));
}

/** True for a key the app owns while a terminal has focus, so xterm leaves it alone. */
export const isTerminalShortcut = (event: KeyboardEvent) => {
  const context = terminalContext();
  return terminalRules.some((rule) => ruleMatches(rule.key, event, inDesktopApp())
    && (actionIdFromCommand(rule.command) === null || (actionShortcutAllowed(event, context)
      && whenHolds(rule.when, context)
      && (hasHandler(rule.command) || hasHandler("projectActions.pending", rule.command)))));
};

/** `a && !b`, with `||` between alternatives. An unknown name is false. */
export function whenHolds(when: string | null, context: WhenContext): boolean {
  if (!when?.trim()) return true;
  return when.split("||").some((alternative) =>
    alternative.split("&&").every((term) => {
      const name = term.trim();
      return name.startsWith("!") ? !context[name.slice(1).trim()] : Boolean(context[name]);
    }),
  );
}

const KEY_LABELS: Record<string, string> = {
  space: "Space",
  esc: "Esc",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/** A rule's key as people write it: mod+o is ⌘O on macOS and Ctrl+O elsewhere. */
export function formatShortcut(rule: string, platform = navigator.platform): string {
  const parts = rule.toLowerCase().split(/\+(?=.)/);
  const key = parts.pop() ?? "";
  const has = (name: string) => parts.includes(name);
  const onMac = /mac/i.test(platform);
  const modifiers: string[] = [];
  const add = (label: string) => {
    if (!modifiers.includes(label)) modifiers.push(label);
  };
  if (has("mod")) add(onMac ? "⌘" : "Ctrl");
  if (has("ctrl")) add(onMac ? "⌃" : "Ctrl");
  if (has("meta") || has("cmd")) add(onMac ? "⌘" : "Meta");
  if (has("alt")) add(onMac ? "⌥" : "Alt");
  if (has("shift")) add(onMac ? "⇧" : "Shift");
  const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return onMac ? `${modifiers.join("")}${label}` : [...modifiers, label].join("+");
}

/** The active key for a command, from the service's rules or the fallback. */
export function commandShortcut(rules: KeybindingRule[] | null | undefined, command: string): string | null {
  const known = rules?.filter((rule) => rule.command === command) ?? [];
  const chosen = known.length > 0
    ? known.find((rule) => !rule.remove)
    : FALLBACK_RULES.find((rule) => rule.command === command && !rule.remove);
  return chosen?.key ?? null;
}

/** What applies before the service's list arrives, or if it can't be read. */
export const FALLBACK_RULES: KeybindingRule[] = (
  [
    ["mod+b", "sidebar.toggle", null],
    ["mod+j", "terminal.toggle", null],
    ["mod+alt+b", "rightPanel.toggle", null],
    ["mod+shift+b", "threadPanel.toggle", "!terminalFocus"],
    ["mod+d", "diff.toggle", "!terminalFocus"],
    ["mod+k", "commandPalette.toggle", "!terminalFocus"],
    ["mod+p", "filePicker.toggle", "!terminalFocus"],
    ["mod+o", "editor.openFavorite", null],
    ["mod+u", "usage.open", "!terminalFocus"],
    ["mod+f", "chat.find", "!terminalFocus && !previewFocus"],
    ["mod+shift+[", "thread.previous", null],
    ["mod+shift+]", "thread.next", null],
    ["mod+shift+c", "thread.copyReference", "!terminalFocus"],
    ["mod+shift+s", "thread.settle", "!terminalFocus"],
    ["mod+shift+p", "thread.pin", "!terminalFocus"],
  ] as const
).map(([key, command, when]) => ({ key, command, when, remove: false }));
