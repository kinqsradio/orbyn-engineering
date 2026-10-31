import { ArrowUp, Folder, GitBranch, ShieldCheck, ShieldOff } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../../api/client";
import type { EngineStatus, SkillSummary, Thread } from "../../api/types";
import { useLayoutWidth } from "../../lib/useLayout";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { EngineGlyph } from "../../ui/badges";
import { insertMention, mentionAt } from "./skillMention";

const MAX_HEIGHT_RATIO = 0.4;
const MENU_ROWS = 6;

export function Composer({
  thread,
  engine,
  profileName,
  beforeSend,
  onSendFailed,
}: {
  thread: Thread;
  engine: EngineStatus | null;
  profileName: string | null;
  /** Runs first and may hold the send, as the hero transition does. */
  beforeSend?(): Promise<void>;
  onSendFailed?(): void;
}) {
  const draft = useUi((state) => state.drafts[thread.id] ?? "");
  const setDraft = useUi((state) => state.setDraft);
  const addPrompt = useThreadLogs((state) => state.addPrompt);
  const refreshThread = useWorkspace((state) => state.refreshThread);
  const layout = useLayoutWidth();
  const field = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const skills = useAsync("composer-skills", (signal) => api.skills(signal));
  const projectBranch = useWorkspace(
    (state) => state.managed.data?.projects.find((p) => p.id === thread.project_id)?.branch ?? null,
  );
  const branch = thread.worktree?.branch ?? projectBranch;
  const busy = thread.active_run !== null;
  const canSend = draft.trim() !== "" && !busy && !sending;

  const mention = menuDismissed ? null : mentionAt(draft, caret);
  const matches = useMemo<SkillSummary[]>(() => {
    if (!mention) return [];
    const needle = mention.query.toLowerCase();
    return (skills.data?.skills ?? [])
      .filter((skill) => skill.enabled && skill.name.toLowerCase().includes(needle))
      .slice(0, MENU_ROWS);
  }, [mention, skills.data]);
  const menuOpen = matches.length > 0;
  const active = Math.min(highlight, Math.max(matches.length - 1, 0));

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    const limit = window.innerHeight * MAX_HEIGHT_RATIO;
    element.style.height = `${Math.min(element.scrollHeight + 2, limit)}px`;
  }, [draft]);

  const pick = (skill: SkillSummary) => {
    if (!mention) return;
    const next = insertMention(draft, caret, mention.start, skill.name);
    setDraft(thread.id, next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => field.current?.setSelectionRange(next.caret, next.caret));
  };

  const send = async () => {
    if (!canSend) return;
    const prompt = draft;
    setSending(true);
    setError(null);
    try {
      await beforeSend?.();
      const run = await api.startRun(thread.id, prompt.trim());
      // Text typed after pressing Send stays; only what was sent is removed.
      const current = useUi.getState().drafts[thread.id] ?? "";
      setDraft(thread.id, current === prompt ? "" : current);
      addPrompt(thread.id, { runId: run.id, text: prompt.trim() });
      void refreshThread(thread.id);
    } catch (failure) {
      onSendFailed?.();
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
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((active + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        const skill = matches[active];
        if (skill) pick(skill);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const unmanaged = engine !== null && !engine.capabilities.managed;
  const engineName = engine?.name ?? thread.engine;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="composer-inner">
      {error ? (
        <p className="field-error composer-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-box">
        {menuOpen ? (
          <ul className="mention-menu" role="listbox" aria-label="Skills">
            {matches.map((skill, at) => (
              <li key={skill.name} role="option" aria-selected={at === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(skill)}
                >
                  <span className="mention-name">${skill.name}</span>
                  <span className="mention-detail">{skill.description}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={field}
          rows={1}
          value={draft}
          onChange={(event) => {
            setDraft(thread.id, event.target.value);
            setCaret(event.target.selectionStart);
            setHighlight(0);
            setMenuDismissed(false);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          aria-label={`Message ${thread.title}`}
          aria-describedby="composer-help"
          placeholder="Ask anything. $ skills"
          data-autofocus={layout === "narrow" ? undefined : true}
        />
        <span id="composer-help" className="sr-only">
          Enter to send, Shift+Enter for a new line
        </span>
        <div className="composer-bar">
          <dl className="composer-left">
            {profileName ? (
              <div>
                <dt className="sr-only">Skill profile</dt>
                <dd>{profileName}</dd>
              </div>
            ) : null}
          </dl>
          <dl className="composer-right">
            <div>
              <dt className="sr-only">Engine</dt>
              <dd>
                <EngineGlyph name={engineName} />
                <span className="sr-only">{engineName}</span>
              </dd>
            </div>
            <div>
              <dt className="sr-only">Model</dt>
              <dd>{thread.model ?? "Default model"}</dd>
            </div>
          </dl>
          <button type="submit" className="send-btn" aria-label="Send" aria-busy={sending || undefined} disabled={!canSend}>
            <ArrowUp size={16} aria-hidden />
          </button>
        </div>
      </div>
      <div className="composer-context">
        <dl>
          <div title={thread.cwd}>
            <dt className="sr-only">Checkout</dt>
            <dd>
              <Folder size={12} aria-hidden />
              {thread.worktree ? "Worktree" : "Current checkout"}
            </dd>
          </div>
          {branch ? (
            <div>
              <dt className="sr-only">Branch</dt>
              <dd>
                <GitBranch size={12} aria-hidden />
                {branch}
              </dd>
            </div>
          ) : null}
        </dl>
        <dl>
          <div>
            <dt className="sr-only">Access</dt>
            <dd className={unmanaged ? "tone-warn" : undefined}>
              {unmanaged ? <ShieldOff size={12} aria-hidden /> : <ShieldCheck size={12} aria-hidden />}
              {unmanaged ? "Unmanaged" : "Asks before acting"}
            </dd>
          </div>
        </dl>
      </div>
      </div>
    </form>
  );
}
