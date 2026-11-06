import { create } from "zustand";
import type { ComposerChip } from "./composerContext";

interface ComposerChipState {
  /** Chips waiting above each thread's composer. */
  chips: Record<string, ComposerChip[]>;
  reviewDrafts: Record<string, { chipId: string; text: string } | undefined>;
  setReviewDraft(threadId: string, draft: { chipId: string; text: string } | undefined): void;
  add(threadId: string, chip: ComposerChip): void;
  addMany(threadId: string, chips: readonly ComposerChip[]): void;
  remove(threadId: string, id: string): void;
  update(threadId: string, chip: ComposerChip): void;
  consume(threadId: string, captured: readonly ComposerChip[]): void;
  clear(threadId: string): void;
}

export const useComposerChips = create<ComposerChipState>((set) => ({
  chips: {},
  reviewDrafts: {},
  setReviewDraft(threadId, draft) {
    set((state) => ({ reviewDrafts: { ...state.reviewDrafts, [threadId]: draft } }));
  },
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
      reviewDrafts: state.reviewDrafts[threadId]?.chipId === id
        ? { ...state.reviewDrafts, [threadId]: undefined } : state.reviewDrafts,
    }));
  },
  clear(threadId) {
    set((state) => ({ chips: { ...state.chips, [threadId]: [] }, reviewDrafts: { ...state.reviewDrafts, [threadId]: undefined } }));
  },
  update(threadId, chip) {
    set((state) => ({ chips: { ...state.chips,
      [threadId]: (state.chips[threadId] ?? []).map((current) => current.id === chip.id ? chip : current),
    } }));
  },
  consume(threadId, captured) {
    // An edit keeps its ID but replaces its value. A late success must retain it.
    set((state) => ({ chips: { ...state.chips,
      [threadId]: (state.chips[threadId] ?? []).filter((current) =>
        (current.kind === "review" && state.reviewDrafts[threadId]?.chipId === current.id
          && state.reviewDrafts[threadId]?.text.trim() !== current.comment.trim())
        || !captured.some((sent) => sent.id === current.id && JSON.stringify(sent) === JSON.stringify(current))),
    } }));
  },
}));
