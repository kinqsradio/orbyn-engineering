import { useEffect, useRef } from "react";
import type { KeybindingRule } from "../api/types";

/** Handlers live with what they act on, and register while mounted. */
const handlers = new Map<string, Set<() => boolean | void>>();

export function runHandlers(command: string): boolean {
  let handled = false;
  for (const handler of handlers.get(command) ?? []) {
    if (handler() !== false) handled = true;
  }
  return handled;
}

export function useCommand(command: string, handler: () => boolean | void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const call = () => latest.current();
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

const eventKey = (event: KeyboardEvent): string => {
  // Shift changes the character, so the physical key names these.
  if (event.shiftKey && SHIFTED_CODE.test(event.code)) {
    if (event.code === "BracketLeft") return "[";
    if (event.code === "BracketRight") return "]";
    return event.code.slice(5);
  }
  return event.key.toLowerCase();
};

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
    key === eventKey(event)
  );
}

export type WhenContext = Record<string, boolean>;

let terminalRules: KeybindingRule[] = [];

/** Keeps the rules that act inside a terminal, which reads the keyboard itself. */
export function setTerminalRules(rules: KeybindingRule[]) {
  terminalRules = rules.filter((rule) => !rule.remove && /(^|[^!])terminalFocus/.test(rule.when ?? ""));
}

/** True for a key the app owns while a terminal has focus, so xterm leaves it alone. */
export const isTerminalShortcut = (event: KeyboardEvent) => terminalRules.some((rule) => matchesKey(rule.key, event));

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

/** What applies before the service's list arrives, or if it can't be read. */
export const FALLBACK_RULES: KeybindingRule[] = (
  [
    ["mod+b", "sidebar.toggle", null],
    ["mod+j", "terminal.toggle", null],
    ["mod+alt+b", "rightPanel.toggle", null],
    ["mod+shift+b", "threadPanel.toggle", "!terminalFocus"],
    ["mod+d", "diff.toggle", "!terminalFocus"],
    ["mod+k", "commandPalette.toggle", "!terminalFocus"],
    ["mod+u", "usage.open", "!terminalFocus"],
    ["mod+f", "chat.find", "!terminalFocus && !previewFocus"],
    ["mod+shift+[", "thread.previous", null],
    ["mod+shift+]", "thread.next", null],
    ["mod+shift+c", "thread.copyReference", "!terminalFocus"],
    ["mod+shift+s", "thread.settle", "!terminalFocus"],
    ["mod+shift+p", "thread.pin", "!terminalFocus"],
  ] as const
).map(([key, command, when]) => ({ key, command, when, remove: false }));
