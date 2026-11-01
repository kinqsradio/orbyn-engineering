import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KeybindingRule } from "../api/types";
import { isTerminalShortcut, runHandlers, setTerminalRules, useCommand } from "./shortcuts";

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
