import { CornerUpLeft, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useThreadStream } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { engineById, useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { Empty } from "../../ui/states";
import { Composer } from "../thread/Composer";
import { ThreadScope } from "../thread/MessageActions";
import { Transcript } from "../thread/Transcript";
import { closeSideChat, openSideChat } from "./sideChat";

function SideChat({ side, parent }: { side: Thread; parent: Thread }) {
  useThreadStream(side.id);
  const engines = useWorkspace((state) => state.engines.data);
  const dropThread = useWorkspace((state) => state.dropThread);
  const pushToast = useUi((state) => state.pushToast);
  const [deleting, setDeleting] = useState(false);
  const used = side.last_run_state !== null || side.active_run !== null;
  const bringBack = () => {
    api.bringBack(side.id).then(
      () => pushToast("The thread gets this with your next message"),
      (failure: unknown) => pushToast(`Couldn't bring it back. ${toFailure(failure).message}`),
    );
  };
  return (
    <ThreadScope.Provider value={side.id}>
      <div className="side-chat" data-side-chat>
        <header className="side-chat-head">
          <Button
            small
            tone="quiet"
            icon={<CornerUpLeft size={14} aria-hidden />}
            disabled={!used || parent.active_run !== null}
            title={parent.active_run ? "Available when the thread is idle" : undefined}
            onClick={bringBack}
          >
            Bring back
          </Button>
          <Button small tone="quiet" icon={<Trash2 size={14} aria-hidden />} onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </header>
        <Transcript threadId={side.id} active={side.active_run !== null} activeRunId={side.active_run?.id ?? null} />
        <Composer thread={side} engine={engineById(engines, side.engine)} showContext={false} side />
        {deleting ? (
          <ConfirmDialog
            title="Delete this side chat?"
            confirmLabel="Delete"
            tone="danger"
            onClose={() => setDeleting(false)}
            onConfirm={async () => {
              await api.deleteThread(side.id);
              dropThread(side);
              useUi.getState().closeSurface("side");
              useUi.getState().setPrefs({ sideChat: null });
            }}
          >
            <p>Its messages are removed. The thread is not changed.</p>
          </ConfirmDialog>
        ) : null}
      </div>
    </ThreadScope.Provider>
  );
}

export function SideChatPane({ parent }: { parent: Thread }) {
  const id = useUi((state) => state.sideChat);
  const side = useWorkspace((state) => (id ? state.threads[id] : undefined));
  if (!side || side.lifecycle?.parent_thread_id !== parent.id) {
    return (
      <Empty title="No side chat open">
        <Button small onClick={() => void openSideChat(parent, null)}>
          Start a side chat
        </Button>
      </Empty>
    );
  }
  return <SideChat key={side.id} side={side} parent={parent} />;
}

export { closeSideChat };
