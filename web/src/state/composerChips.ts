import { create } from "zustand";
import type { ComposerChip } from "../features/thread/composerContext";

interface ComposerChipState {
  /** Chips waiting above each thread's composer. */
  chips: Record<string, ComposerChip[]>;
  add(threadId: string, chip: ComposerChip): void;
  addMany(threadId: string, chips: readonly ComposerChip[]): void;
  remove(threadId: string, id: string): void;
  clear(threadId: string): void;
}

export const useComposerChips = create<ComposerChipState>((set) => ({
  chips: {},
  add(threadId, chip) {
    set((state) => ({ chips: { ...state.chips, [threadId]: [...(state.chips[threadId] ?? []), chip] } }));
  },
  addMany(threadId, chips) {
    if (chips.length === 0) return;
    set((state) => ({ chips: { ...state.chips, [threadId]: [...(state.chips[threadId] ?? []), ...chips] } }));
  },
  remove(threadId, id) {
    set((state) => ({
      chips: { ...state.chips, [threadId]: (state.chips[threadId] ?? []).filter((chip) => chip.id !== id) },
    }));
  },
  clear(threadId) {
    set((state) => ({ chips: { ...state.chips, [threadId]: [] } }));
  },
}));
