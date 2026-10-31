import { Bot, Boxes, CornerDownLeft, SendHorizontal, Sparkles } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../../api/client";
import type { EngineStatus, Thread } from "../../api/types";
import { useLayoutWidth } from "../../lib/useLayout";
import { toFailure } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, Pill } from "../../ui/controls";

const MAX_HEIGHT_RATIO = 0.4;

export function Composer({
  thread,
  engine,
  profileName,
}: {
  thread: Thread;
  engine: EngineStatus | null;
  profileName: string | null;
}) {
  const draft = useUi((state) => state.drafts[thread.id] ?? "");
  const setDraft = useUi((state) => state.setDraft);
  const addPrompt = useThreadLogs((state) => state.addPrompt);
  const refreshThread = useWorkspace((state) => state.refreshThread);
  const layout = useLayoutWidth();
  const field = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = thread.active_run !== null;
  const canSend = draft.trim() !== "" && !busy && !sending;

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    const limit = window.innerHeight * MAX_HEIGHT_RATIO;
    element.style.height = `${Math.min(element.scrollHeight + 2, limit)}px`;
  }, [draft]);

  const send = async () => {
    if (!canSend) return;
    const prompt = draft;
    setSending(true);
    setError(null);
    try {
      const run = await api.startRun(thread.id, prompt.trim());
      // Text typed after pressing Send stays; only what was sent is removed.
      const current = useUi.getState().drafts[thread.id] ?? "";
      setDraft(thread.id, current === prompt ? "" : current);
      addPrompt(thread.id, { runId: run.id, text: prompt.trim() });
      void refreshThread(thread.id);
    } catch (failure) {
      const known = toFailure(failure);
      if (known.code === "folder_untrusted") {
        navigate({ name: "trust", projectId: thread.project_id, threadId: thread.id });
        return;
      }
      setError(
        known.code === "thread_busy"
          ? "A run is already active in this thread. Your message is kept."
          : `Couldn't start the run. ${known.message} Your message is kept.`,
      );
      void refreshThread(thread.id);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const unmanaged = engine !== null && !engine.capabilities.managed;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {error ? (
        <p className="field-error composer-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-box">
        <textarea
          ref={field}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(thread.id, event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={`Message ${thread.title}`}
          aria-describedby="composer-help"
          placeholder={busy ? "A run is active. You can keep typing." : "Describe the task"}
          data-autofocus={layout === "narrow" ? undefined : true}
        />
        <div className="composer-bar">
          <dl className="composer-meta">
            <div title="Engine">
              <dt className="sr-only">Engine</dt>
              <dd>
                <Bot size={16} aria-hidden />
                {engine?.name ?? thread.engine}
              </dd>
            </div>
            <div title="Model">
              <dt className="sr-only">Model</dt>
              <dd>
                <Boxes size={16} aria-hidden />
                {thread.model ?? "Default model"}
              </dd>
            </div>
            <div title="Skill profile">
              <dt className="sr-only">Skill profile</dt>
              <dd>
                <Sparkles size={16} aria-hidden />
                {profileName ?? "All skills"}
              </dd>
            </div>
            {unmanaged ? (
              <div>
                <dt className="sr-only">Governance</dt>
                <dd>
                  <Pill tone="warn">Unmanaged</Pill>
                </dd>
              </div>
            ) : null}
          </dl>
          <span id="composer-help" className="composer-help">
            <CornerDownLeft size={16} aria-hidden />
            <span>Enter to send, Shift+Enter for a new line</span>
          </span>
          <Button
            type="submit"
            tone="primary"
            small
            busy={sending}
            disabled={!canSend}
            icon={<SendHorizontal size={16} aria-hidden />}
          >
            Send
          </Button>
        </div>
      </div>
    </form>
  );
}
