import { create } from "zustand";
import { useUi } from "../state/ui";

/**
 * On small windows (600 to 899 px) the sidebar is a drawer over the thread, opened from the title
 * bar's sidebar button. It starts closed and is not saved.
 */
export const useSidebarDrawer = create<{ open: boolean; setOpen(open: boolean): void; toggle(): void; close(): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
}));

/** The title bar button and the shortcut: opening the drawer closes the side panel, as a small window fits only one. */
export function toggleSidebarDrawer() {
  const opening = !useSidebarDrawer.getState().open;
  if (opening) useUi.getState().closePanel();
  useSidebarDrawer.getState().setOpen(opening);
}
