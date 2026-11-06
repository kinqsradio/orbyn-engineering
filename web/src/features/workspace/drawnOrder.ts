import { create } from "zustand";

/**
 * The thread IDs the sidebar draws, in order, so keyboard jumps follow what is on screen.
 * Null while no sidebar is mounted; callers then fall back to the default arrangement.
 */
export const useDrawnOrder = create<{ ids: string[] | null; set(ids: string[] | null): void }>((set) => ({
  ids: null,
  set: (ids) => set({ ids }),
}));
