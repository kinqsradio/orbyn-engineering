import { create } from "zustand";

/** Viewer layout only: moving a tab never recreates its service-owned browser. */
export const useBrowserPanels = create<{
  moved: Record<string, string>;
  move(threadId: string, tabId: string | null): void;
}>((set) => ({
  moved: {},
  move(threadId, tabId) {
    set((state) => {
      const moved = { ...state.moved };
      if (tabId) moved[threadId] = tabId;
      else delete moved[threadId];
      return { moved };
    });
  },
}));

export function previewWindowRoute(hash: string): { threadId: string; tabId: string } | null {
  const match = /^#\/preview\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(hash);
  return match?.[1] && match[2] ? { threadId: match[1], tabId: match[2] } : null;
}
