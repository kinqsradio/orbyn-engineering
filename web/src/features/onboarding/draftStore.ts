import { create } from "zustand";

export const DRAFT_KEY = "new-thread";
export const SCRATCH = "scratch";

/** What waits for a thread that doesn't exist yet, or for a composer that isn't open. */
interface DraftStore {
  /** Files for the next new thread, so a project switch or the trust step keeps them. */
  files: File[];
  setFiles(files: File[]): void;
  /** A worktree the next new thread reuses, by its purpose. */
  reuseWorktree: string | null;
  setReuseWorktree(purpose: string | null): void;
  /** Files dropped on a thread's row, on their way to its composer. */
  dropped: Record<string, File[]>;
  drop(threadId: string, files: File[]): void;
  takeDropped(threadId: string): File[];
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  files: [],
  setFiles: (files) => set({ files }),
  reuseWorktree: null,
  setReuseWorktree: (reuseWorktree) => set({ reuseWorktree }),
  dropped: {},
  drop: (threadId, files) =>
    set((state) => ({ dropped: { ...state.dropped, [threadId]: [...(state.dropped[threadId] ?? []), ...files] } })),
  takeDropped(threadId) {
    const { [threadId]: taken = [], ...others } = get().dropped;
    set({ dropped: others });
    return taken;
  },
}));

/** The folder name is the purpose the service made the worktree from. */
export const worktreePurpose = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
