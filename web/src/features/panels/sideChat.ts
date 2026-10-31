import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";

export const sideChatsOf = (threads: Record<string, Thread>, parentId: string) =>
  Object.values(threads)
    .filter((thread) => thread.lifecycle?.relation === "side" && thread.lifecycle.parent_thread_id === parentId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

export function showSideChat(id: string) {
  const { openSurfaces, setPrefs, setPanelOpen } = useUi.getState();
  setPrefs({
    sideChat: id,
    panelTab: "side",
    openSurfaces: openSurfaces.includes("side") ? openSurfaces : [...openSurfaces, "side"],
  });
  setPanelOpen(true);
}

/** Starts from what the thread knows; the thread itself keeps working. */
export async function openSideChat(parent: Thread, question: string | null) {
  const ui = useUi.getState();
  try {
    const side = await api.startSideChat(parent.id);
    useWorkspace.getState().putThread(side);
    showSideChat(side.id);
    if (question) {
      const run = await api.startRun(side.id, question);
      useThreadLogs.getState().addPrompt(side.id, { runId: run.id, text: question });
      void useWorkspace.getState().refreshThread(side.id);
    }
  } catch (failure) {
    ui.pushToast(`Couldn't start a side chat. ${toFailure(failure).message}`);
  }
}

/** Closes the tab. One you never used goes with it, since nothing would find it again. */
export function closeSideChat() {
  const { sideChat, closeSurface, setPrefs } = useUi.getState();
  const { threads, dropThread } = useWorkspace.getState();
  const side = sideChat ? threads[sideChat] : undefined;
  closeSurface("side");
  setPrefs({ sideChat: null });
  if (side && side.active_run === null && side.last_run_state === null) {
    dropThread(side);
    void api.deleteThread(side.id).catch(() => undefined);
  }
}
