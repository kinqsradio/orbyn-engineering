import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KeybindingRule } from "../api/types";
import { isTerminalShortcut, commandShortcut, formatShortcut, runHandlers, setTerminalRules, useCommand } from "./shortcuts";

const command = "script.fixture-action.run";
const rule = (key: string, when: string | null = null): KeybindingRule => ({ key, command, when, remove: false });
const key = (value: string, options: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: value, ...options });
afterEach(() => setTerminalRules([]));

function Owner({ available = true }: { available?: boolean }) {
  useCommand(command, () => undefined, () => available);
  return null;
}

it("leaves bare action keys to the terminal's editable input", () => {
  render(<Owner />);
  setTerminalRules([rule("k")], () => ({ terminalFocus: true, editableFocus: true }));
  expect(isTerminalShortcut(key("k"))).toBe(false);
});

it("reserves contextual action keys only while their actual condition holds", () => {
  render(<Owner />);
  let running = false;
  setTerminalRules([rule("ctrl+k", "terminalFocus && turnRunning")], () => ({ terminalFocus: true, editableFocus: true, turnRunning: running }));
  expect(isTerminalShortcut(key("k", { ctrlKey: true }))).toBe(false);
  running = true;
  expect(isTerminalShortcut(key("k", { ctrlKey: true }))).toBe(true);
});

it("shares pending catalog and route ownership between terminal reservation and dispatch", () => {
  let active = true;
  const run = vi.fn();
  function Pending() {
    useCommand("projectActions.pending", run, (argument) => active && argument === command);
    return null;
  }
  render(<Pending />);
  setTerminalRules([rule("ctrl+k")], () => ({ terminalFocus: true, editableFocus: true }));
  expect(isTerminalShortcut(key("k", { ctrlKey: true }))).toBe(true);
  expect(run).not.toHaveBeenCalled();
  expect(runHandlers("projectActions.pending", command)).toBe(true);
  expect(run).toHaveBeenCalledExactlyOnceWith(command);
  active = false;
  expect(isTerminalShortcut(key("k", { ctrlKey: true }))).toBe(false);
  expect(runHandlers("projectActions.pending", command)).toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
});

it("does not reserve action keys for an inactive owner, a dialog, or repeated events", () => {
  const view = render(<Owner available={false} />);
  let dialogOpen = false;
  setTerminalRules([rule("ctrl+k")], () => ({ terminalFocus: true, editableFocus: true, dialogOpen }));
  expect(isTerminalShortcut(key("k", { ctrlKey: true }))).toBe(false);
  expect(runHandlers(command)).toBe(false);
  view.rerender(<Owner />);
  expect(isTerminalShortcut(key("k", { ctrlKey: true }))).toBe(true);
  dialogOpen = true;
  expect(isTerminalShortcut(key("k", { ctrlKey: true }))).toBe(false);
  dialogOpen = false;
  expect(isTerminalShortcut(key("k", { ctrlKey: true, repeat: true }))).toBe(false);
  expect(isTerminalShortcut(key("k", { ctrlKey: true, isComposing: true }))).toBe(false);
});

it("formats rules the way each platform writes them", () => {
  expect(formatShortcut("mod+o", "MacIntel")).toBe("⌘O");
  expect(formatShortcut("mod+o", "Win32")).toBe("Ctrl+O");
  expect(formatShortcut("mod+shift+alt+p", "MacIntel")).toBe("⌘⌥⇧P");
  expect(formatShortcut("mod+shift+alt+p", "Linux x86_64")).toBe("Ctrl+Alt+Shift+P");
  expect(formatShortcut("ctrl+space", "MacIntel")).toBe("⌃Space");
  expect(formatShortcut("esc", "Win32")).toBe("Esc");
  expect(formatShortcut("mod+[", "MacIntel")).toBe("⌘[");
});

it("reads a command's key from the service, the fallback, or a removed rule", () => {
  expect(commandShortcut([{ key: "mod+shift+o", command: "editor.openFavorite", when: null, remove: false }], "editor.openFavorite")).toBe("mod+shift+o");
  expect(commandShortcut(null, "editor.openFavorite")).toBe("mod+o");
  expect(commandShortcut([{ key: "mod+o", command: "editor.openFavorite", when: null, remove: true }], "editor.openFavorite")).toBeNull();
  expect(commandShortcut([], "editor.openFavorite")).toBe("mod+o");
});

it("gives mod+w rules an alt+w alternate in a browser only", async () => {
  const { browserAlternate, isReservedCloseEvent, ruleMatches } = await import("./shortcuts");
  const ctrlW = key("w", { ctrlKey: true, metaKey: true });
  const altW = key("w", { altKey: true });
  expect(browserAlternate("mod+w")).toBe("alt+w");
  expect(browserAlternate("mod+shift+w")).toBe("alt+shift+w");
  expect(browserAlternate("mod+k")).toBeNull();
  expect(ruleMatches("mod+w", altW, false)).toBe(true);
  expect(ruleMatches("mod+w", altW, true)).toBe(false);
  expect(ruleMatches("mod+k", altW, false)).toBe(false);
  const mod = /mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  expect(isReservedCloseEvent(key("w", mod))).toBe(true);
  expect(isReservedCloseEvent(ctrlW)).toBe(false);
});
