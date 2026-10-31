import { Check, Copy, GitBranch, GitBranchPlus, Pencil, Undo2 } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { navigate, parseRoute } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { IconButton } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";

/** The thread these messages belong to, when it isn't the one the page is on. */
export const ThreadScope = createContext<string | null>(null);

const openThread = () => {
  const route = parseRoute(window.location.hash);
  return route.name === "thread" ? route.id : null;
};

/** Hover actions on a message: copy, and rewind or fork at its run. */
export function MessageActions({ text, runId, role }: { text: string; runId: string | null; role: "user" | "assistant" }) {
  const [copied, setCopied] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [restoreFiles, setRestoreFiles] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  const scoped = useContext(ThreadScope);
  const threadId = scoped ?? openThread();
  const busy = useWorkspace((state) => (threadId ? state.threads[threadId]?.active_run !== null : true));

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const fork = async () => {
    if (!threadId || !runId) return;
    try {
      const child = await api.forkThread(threadId, runId);
      useWorkspace.getState().putThread(child);
      navigate({ name: "thread", id: child.id });
    } catch (failure) {
      pushToast(`Couldn't fork. ${toFailure(failure).message}`);
    }
  };

  /** Leaves this thread alone: the new one starts before the message, with it in the composer. */
  const editInNewThread = async () => {
    if (!threadId || !runId) return;
    try {
      const child = await api.forkBefore(threadId, runId);
      useWorkspace.getState().putThread(child);
      useUi.getState().setDraft(child.id, text);
      navigate({ name: "thread", id: child.id });
    } catch (failure) {
      pushToast(`Couldn't fork. ${toFailure(failure).message}`);
    }
  };

  return (
    <div className="msg-actions">
      {role === "user" && runId ? (
        <IconButton label="Edit from here" disabled={busy} onClick={() => setRewinding(true)}>
          <Pencil size={14} aria-hidden />
        </IconButton>
      ) : null}
      {role === "user" && runId ? (
        <IconButton label="Edit in a new thread" onClick={() => void editInNewThread()}>
          <GitBranchPlus size={14} aria-hidden />
        </IconButton>
      ) : null}
      <IconButton label="Copy message" onClick={copy}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </IconButton>
      {role === "assistant" && runId ? (
        <IconButton label="Fork from this response" onClick={() => void fork()}>
          <GitBranch size={14} aria-hidden />
        </IconButton>
      ) : null}
      {role === "assistant" && runId ? (
        <IconButton label="Restore files to before this response" disabled={busy} onClick={() => setRestoring(true)}>
          <Undo2 size={14} aria-hidden />
        </IconButton>
      ) : null}
      {restoring ? (
        <ConfirmDialog
          title="Restore files?"
          confirmLabel="Restore files"
          onClose={() => setRestoring(false)}
          onConfirm={async () => {
            if (!threadId || !runId) return;
            await api.restoreWorkspace(threadId, runId, "start");
            useThreadLogs.getState().touchDiff(threadId);
            pushToast("Files restored");
          }}
        >
          <p>The folder goes back to how it was before this turn. What it holds now is saved first, so this can be undone from Git.</p>
        </ConfirmDialog>
      ) : null}
      {rewinding ? (
        <ConfirmDialog
          title="Edit from here?"
          confirmLabel="Rewind"
          onClose={() => setRewinding(false)}
          onConfirm={async () => {
            if (!threadId || !runId) return;
            await api.rewindThread(threadId, runId, restoreFiles);
            useUi.getState().setDraft(threadId, text);
            await useWorkspace.getState().refreshThread(threadId);
          }}
        >
          <p>The conversation continues from before this message.</p>
          <label className="check">
            <input
              type="checkbox"
              checked={restoreFiles}
              onChange={(event) => setRestoreFiles(event.target.checked)}
            />
            <span>Also restore files to this point</span>
          </label>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
