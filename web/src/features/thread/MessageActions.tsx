import { Check, Copy, GitBranch, Pencil, Quote, Undo2 } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { navigate, parseRoute } from "../../state/route";
import { useThreadLogs } from "./threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { useComposerChips } from "./composerChipStore";
import { IconButton } from "../../ui/controls";
import { chipId } from "./composerContext";
import { ConfirmDialog } from "../../ui/Dialog";

/** The thread these messages belong to, when it isn't the one the page is on. */
export const ThreadScope = createContext<string | null>(null);

const openThread = () => {
  const route = parseRoute(window.location.hash);
  return route.name === "thread" ? route.id : null;
};

/** Confirms, then puts the folder back to how it was before a turn. */
export function RestoreFilesDialog({ threadId, runId, onClose }: { threadId: string; runId: string; onClose(): void }) {
  const pushToast = useUi((state) => state.pushToast);
  return (
    <ConfirmDialog
      title="Restore files?"
      confirmLabel="Restore files"
      onClose={onClose}
      onConfirm={async () => {
        await api.restoreWorkspace(threadId, runId, "start");
        useThreadLogs.getState().touchDiff(threadId);
        pushToast("Files restored");
      }}
    >
      <p>The folder goes back to how it was before this turn. What it holds now is saved first, so this can be undone from Git.</p>
    </ConfirmDialog>
  );
}

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
  /** A selection in this reply wins; otherwise the whole reply is cited. */
  const cite = () => {
    if (!threadId) return;
    const selected = window.getSelection()?.toString().trim() ?? "";
    const excerpt = (selected || text).trim().slice(0, 4000);
    if (!excerpt) return;
    useComposerChips.getState().add(threadId, { id: chipId(), kind: "citation", threadId, text: excerpt });
    pushToast("Cited in your message");
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

  return (
    <div className="msg-actions">
      {role === "user" && runId ? (
        <IconButton label="Edit from here" disabled={busy} onClick={() => setRewinding(true)}>
          <Pencil size={14} aria-hidden />
        </IconButton>
      ) : null}
      <IconButton label="Copy message" onClick={copy}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </IconButton>
      {role === "assistant" && threadId ? (
        <IconButton label="Cite in your message" onClick={cite}>
          <Quote size={14} aria-hidden />
        </IconButton>
      ) : null}
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
      {restoring && threadId && runId ? <RestoreFilesDialog threadId={threadId} runId={runId} onClose={() => setRestoring(false)} /> : null}
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
