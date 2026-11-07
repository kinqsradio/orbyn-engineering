import { create } from "zustand";
import type { RightTab } from "../../state/ui";

/**
 * Panel tabs the person has closed. A closed tab leaves the row and comes back from the "+" at its
 * end. Nothing closes a tab yet, so this stays empty and the "+" stays hidden until it does
 * (data-gated); the design draws the reopen menu in that place.
 */
export const useClosedTabs = create<{ closed: readonly RightTab[]; close(id: RightTab): void; reopen(id: RightTab): void }>((set) => ({
  closed: [],
  close: (id) => set((state) => (state.closed.includes(id) ? state : { closed: [...state.closed, id] })),
  reopen: (id) => set((state) => ({ closed: state.closed.filter((entry) => entry !== id) })),
}));
