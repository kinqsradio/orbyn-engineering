import { create } from "zustand";

export type UndoAction = "Settled" | "Snoozed" | "Unpinned" | "Archived" | "Discarded";

export const UNDO_MS = 5000;

interface UndoEntry {
  action: UndoAction;
  undo: () => Promise<unknown>;
}

interface UndoState {
  notice: { action: UndoAction; count: number } | null;
}

export const useUndoNotice = create<UndoState>(() => ({ notice: null }));

let entries: UndoEntry[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;
/** A new notice owns the shortcut, even in a field, until another key or an edit. */
let shortcutClaimed = false;

const clear = () => {
  clearTimeout(expiry);
  entries = [];
  shortcutClaimed = false;
  useUndoNotice.setState({ notice: null });
};

/** Adjacent actions of one kind undo together, as one notice. */
export function pushUndo(action: UndoAction, undo: () => Promise<unknown>): void {
  if (entries.at(-1)?.action !== action) entries = [];
  entries = [...entries, { action, undo }];
  shortcutClaimed = true;
  useUndoNotice.setState({ notice: { action, count: entries.length } });
  clearTimeout(expiry);
  expiry = setTimeout(clear, UNDO_MS);
}

export async function undoLatest(): Promise<void> {
  const taken = entries;
  clear();
  await Promise.all(taken.map((entry) => entry.undo()));
}

export function undoHasShortcut(): boolean {
  return shortcutClaimed;
}

export function releaseUndoShortcut(): void {
  shortcutClaimed = false;
}

const isMac = () => /mac|iphone|ipad/i.test(navigator.platform);

export const modKeyLabel = () => (isMac() ? "⌘" : "Ctrl+");

export const undoLabel = () => `${modKeyLabel()}Z to undo`;
