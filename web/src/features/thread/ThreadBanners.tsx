import { CircleAlert, Clock, Gauge, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { Thread, UpdateThread } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, IconButton } from "../../ui/controls";

const dismissed = new Set<string>();

const CONTINUE = "Continue where you left off.";

const resetLabel = (at: string) =>
  new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** An engine stopped on a limit: its words, when it comes back, and what to do until then. */
export function LimitBanner({ thread }: { thread: Thread }) {
  const refreshThread = useWorkspace((state) => state.refreshThread);
  const putThread = useWorkspace((state) => state.putThread);
  const pushToast = useUi((state) => state.pushToast);
  const limit = thread.lifecycle?.limit;
  if (!limit || thread.active_run) return null;
  const failed = (error: unknown) => pushToast(`Couldn't do that. ${toFailure(error).message}`);
  const patch = (body: UpdateThread) => api.patchThread(thread.id, body).then(putThread, failed);
  const future = limit.resets_at !== null && new Date(limit.resets_at).getTime() > Date.now();
  const snoozedUntilReset = future && thread.lifecycle?.snoozed_until != null &&
    Date.parse(thread.lifecycle.snoozed_until) === Date.parse(limit.resets_at ?? "");
  return (
    <div className="thread-error" role="status" aria-label="Limited">
      <Gauge size={14} aria-hidden />
      <span>
        {limit.message}
        {limit.resets_at ? ` Resets ${resetLabel(limit.resets_at)}.` : ""}
      </span>
      <Button
        small
        tone="quiet"
        icon={<RotateCcw size={12} aria-hidden />}
        onClick={() => {
          api.startRun(thread.id, CONTINUE).then(() => void refreshThread(thread.id), failed);
        }}
      >
        Resume
      </Button>
      {future ? (
        <Button small tone="quiet" onClick={() => void patch({ resume_at_reset: limit.resume_at === null })}>
          {limit.resume_at ? "Cancel auto-resume" : "Resume at reset"}
        </Button>
      ) : null}
      {future ? (
        <Button
          small
          tone="quiet"
          icon={<Clock size={12} aria-hidden />}
          onClick={() => void patch(snoozedUntilReset ? { wake: true } : { snoozed_until: limit.resets_at ?? undefined })}
        >
          {snoozedUntilReset ? "Wake now" : "Snooze until reset"}
        </Button>
      ) : null}
    </div>
  );
}

/** The latest failure, with a way to send the same prompt again. Dismissal lasts the session. */
export function ThreadErrorBanner({ thread }: { thread: Thread }) {
  const items = useThreadLogs((state) => state.logs[thread.id]?.items);
  const [, redraw] = useState(0);
  const refreshThread = useWorkspace((state) => state.refreshThread);
  const pushToast = useUi((state) => state.pushToast);
  if (thread.active_run || thread.last_run_state !== "failed" || thread.lifecycle?.limit || !items) return null;
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
