import { create } from "zustand";

/** A page's own label for the title bar, when the route alone doesn't say (one pull request). */
export const usePageLabel = create<{ label: string | null; set(label: string | null): void }>((set) => ({
  label: null,
  set: (label) => set({ label }),
}));
