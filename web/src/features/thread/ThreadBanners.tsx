import { CircleAlert, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, IconButton } from "../../ui/controls";

const dismissed = new Set<string>();

/** The latest failure, with a way to send the same prompt again. Dismissal lasts the session. */
export function ThreadErrorBanner({ thread }: { thread: Thread }) {
  const items = useThreadLogs((state) => state.logs[thread.id]?.items);
  const [, redraw] = useState(0);
  const refreshThread = useWorkspace((state) => state.refreshThread);
  const pushToast = useUi((state) => state.pushToast);
  if (thread.active_run || thread.last_run_state !== "failed" || !items) return null;
  const failure = items.findLast((item) => item.kind === "notice" && item.tone === "error");
  if (!failure || failure.kind !== "notice" || dismissed.has(failure.key)) return null;
  const prompt = items.findLast((item) => item.kind === "message" && item.role === "user");
  const retry = () => {
    if (prompt?.kind !== "message") return;
    api.startRun(thread.id, prompt.text).then(
      () => void refreshThread(thread.id),
      (error: unknown) => pushToast(`Couldn't retry. ${toFailure(error).message}`),
    );
  };
  return (
    <div className="thread-error">
      <CircleAlert size={14} aria-hidden />
      <span>{failure.text}</span>
      {prompt ? (
        <Button small tone="quiet" icon={<RotateCcw size={12} aria-hidden />} onClick={retry}>
          Retry
        </Button>
      ) : null}
      <IconButton
        label="Dismiss error"
        onClick={() => {
          dismissed.add(failure.key);
          redraw((count) => count + 1);
        }}
      >
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  );
}
