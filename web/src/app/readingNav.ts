import { create } from "zustand";

/** In the Reading layout the sidebar is folded away; the title bar toggle opens it. Not saved. */
export const useReadingNav = create<{ open: boolean; toggle(): void; close(): void }>((set) => ({
  open: false,
  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
}));
