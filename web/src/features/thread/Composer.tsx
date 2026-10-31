import { ArrowUp, Folder, GitBranch, Lock, Paperclip, Pencil, ShieldOff, Square, Wand2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../../api/client";
import type { Attachment, EngineStatus, PermissionMode, Thread } from "../../api/types";
import { useLayoutWidth } from "../../lib/useLayout";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { useWorkspace } from "../../state/workspace";
import { EngineGlyph } from "../../ui/badges";
import { Menu } from "../../ui/Menu";
import { QueuedMessages } from "./QueuedMessages";
import { insertToken, triggerAt } from "./skillMention";

const accessLabels: Record<PermissionMode, string> = {
  supervised: "Supervised",
  auto_edits: "Auto-accept edits",
  auto: "Auto",
  full_access: "Full access",
};

const accessIcons: Record<PermissionMode, typeof Lock> = {
  supervised: Lock,
  auto_edits: Pencil,
  auto: Wand2,
  full_access: ShieldOff,
};

const ACCESS_MODES = Object.keys(accessLabels) as PermissionMode[];

interface Suggestion {
  value: string;
  detail: string | null;
}

const MAX_HEIGHT_RATIO = 0.4;
const MENU_ROWS = 6;

export function Composer({
  thread,
  engine,
  beforeSend,
  onSendFailed,
  showContext,
}: {
  thread: Thread;
  engine: EngineStatus | null;
  /** Runs first and may hold the send, as the hero transition does. */
  beforeSend?(): Promise<void>;
  onSendFailed?(): void;
  /** The checkout, branch and access row, shown when nothing else carries them. */
  showContext: boolean;
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const refreshAll = useWorkspace((state) => state.refreshAll);
  const [accessMenu, setAccessMenu] = useState<{ x: number; y: number } | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const putThread = useWorkspace((state) => state.putThread);
  const projectBranch = useWorkspace(
    (state) => state.managed.data?.targets.find((t) => t.project_id === thread.project_id)?.branch ?? null,
  );
  const branch = thread.worktree?.branch ?? projectBranch;
  const busy = thread.active_run !== null;
  const canSend = draft.trim() !== "" && !sending;
  const queue = useAsync(`queue:${thread.id}`, (signal) => api.queue(thread.id, signal));
  const reloadQueue = queue.reload;
  const runId = thread.active_run?.id ?? null;
  useEffect(() => {
    reloadQueue();
  }, [runId, reloadQueue]);

  const trigger = menuDismissed ? null : triggerAt(draft, caret);
  const lookupKey = trigger ? `${thread.id}:${trigger.char}:${trigger.query}` : `${thread.id}:idle`;
  const lookup = useAsync<Suggestion[]>(lookupKey, async (signal) => {
    if (!trigger) return [];
    if (trigger.char === "/") {
      const commands = await api.commands(thread.id, signal);
      const needle = trigger.query.toLowerCase();
      return commands
        .filter((command) => command.name.toLowerCase().includes(needle))
        .map((command) => ({ value: command.name, detail: command.description }));
    }
    const found = await api.mentions(thread.id, trigger.query, signal);
    const values = trigger.char === "$" ? found.skills : found.files;
    return values.map((value) => ({ value, detail: null }));
  });
  const matches = useMemo(() => (trigger ? (lookup.data ?? []).slice(0, MENU_ROWS) : []), [trigger, lookup.data]);
  const menuOpen = matches.length > 0;
  const active = Math.min(highlight, Math.max(matches.length - 1, 0));

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    const limit = window.innerHeight * MAX_HEIGHT_RATIO;
    element.style.height = `${Math.min(element.scrollHeight + 2, limit)}px`;
  }, [draft]);

  const pick = (suggestion: Suggestion) => {
    if (!trigger) return;
    const next = insertToken(draft, caret, trigger, suggestion.value);
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
      await Promise.all(pendingHere.map((approval) => api.decideApproval(approval.id, false, false)));
      const ids = attachments.map((file) => file.id);
      const run = busy ? null : await api.startRun(thread.id, prompt.trim(), ids);
      if (busy) await api.enqueue(thread.id, prompt.trim(), ids);
      setAttachments([]);
      // Text typed after pressing Send stays; only what was sent is removed.
      const current = useUi.getState().drafts[thread.id] ?? "";
      setDraft(thread.id, current === prompt ? "" : current);
      if (run) addPrompt(thread.id, { runId: run.id, text: prompt.trim() });
      if (busy) reloadQueue();
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
          ? "A run started first. Your message is kept, so send it again to queue it."
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
        const suggestion = matches[active];
        if (suggestion) pick(suggestion);
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

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const added = await Promise.all([...files].map((file) => api.uploadAttachment(thread.id, file)));
      setAttachments((current) => [...current, ...added]);
    } catch (failure) {
      setError(`Couldn't attach that. ${toFailure(failure).message}`);
    } finally {
      setUploading(false);
      if (filePicker.current) filePicker.current.value = "";
    }
  };

  const setAccess = async (mode: PermissionMode) => {
    setError(null);
    try {
      putThread(await api.patchThread(thread.id, { permission_mode: mode }));
    } catch (failure) {
      setError(`Couldn't change access. ${toFailure(failure).message}`);
    }
  };

  const approvals = useWorkspace((state) => state.approvals.data);
  const pendingHere = useMemo(
    () => (approvals ?? []).filter((approval) => approval.thread_id === thread.id),
    [approvals, thread.id],
  );

  const stop = async () => {
    if (!thread.active_run) return;
    setStopping(true);
    setError(null);
    try {
      await api.cancelRun(thread.active_run.id);
      void refreshAll();
    } catch (failure) {
      setError(`Couldn't stop the run. ${toFailure(failure).message}`);
    } finally {
      setStopping(false);
    }
  };

  const unmanaged = engine !== null && !engine.capabilities.managed;
  const access = thread.lifecycle?.permission_mode ?? "supervised";
  const AccessIcon = accessIcons[access];
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
      <QueuedMessages threadId={thread.id} items={queue.data ?? []} running={busy} onChange={reloadQueue} />
      <div className="composer-box">
        {menuOpen ? (
          <ul className="mention-menu" role="listbox" aria-label="Suggestions">
            {matches.map((suggestion, at) => (
              <li key={suggestion.value} role="option" aria-selected={at === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(suggestion)}
                >
                  <span className="mention-name">
                    {trigger?.char}
                    {suggestion.value}
                  </span>
                  {suggestion.detail ? <span className="mention-detail">{suggestion.detail}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {attachments.length > 0 ? (
          <ul className="attachment-strip" aria-label="Attachments">
            {attachments.map((file) => (
              <li key={file.id}>
                <span>{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setAttachments(attachments.filter((entry) => entry.id !== file.id))}
                >
                  <X size={12} aria-hidden />
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
          placeholder={
            pendingHere.length > 0
              ? "Send a message to decline and redirect the agent"
              : "Ask anything. @ files, $ skills, / commands"
          }
          data-autofocus={layout === "narrow" ? undefined : true}
        />
        <span id="composer-help" className="sr-only">
          Enter to send, Shift+Enter for a new line
        </span>
        <div className="composer-bar">
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            aria-label="Attach files"
            onChange={(event) => void upload(event.target.files)}
          />
          <IconButton
            label={uploading ? "Attaching" : "Attach files"}
            disabled={uploading}
            onClick={() => filePicker.current?.click()}
          >
            <Paperclip size={16} aria-hidden />
          </IconButton>
          <dl className="composer-left">
          </dl>
          <dl className="composer-right">
            {showContext ? null : (
              <div>
                <dt className="sr-only">Access</dt>
                <dd>{unmanaged ? "Unmanaged" : accessLabels[access]}</dd>
              </div>
            )}
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
          {busy && !draft.trim() ? (
            <button
              type="button"
              className="send-btn stop-btn"
              aria-label="Stop"
              disabled={stopping}
              onClick={() => void stop()}
            >
              <Square size={12} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              className="send-btn"
              aria-label={busy ? "Queue" : "Send"}
              aria-busy={sending || undefined}
              disabled={!canSend}
            >
              <ArrowUp size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="composer-context" hidden={!showContext}>
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
              {unmanaged ? (
                <>
                  <ShieldOff size={12} aria-hidden />
                  Unmanaged
                </>
              ) : (
                <button
                  type="button"
                  className="context-action"
                  aria-haspopup="menu"
                  disabled={busy || !thread.lifecycle}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setAccessMenu({ x: rect.left, y: rect.top - 4 - ACCESS_MODES.length * 32 });
                  }}
                >
                  <AccessIcon size={12} aria-hidden />
                  {accessLabels[access]}
                </button>
              )}
            </dd>
          </div>
        </dl>
      </div>
      {accessMenu ? (
        <Menu
          {...accessMenu}
          origin="bottom left"
          label="Access"
          onClose={() => setAccessMenu(null)}
          items={ACCESS_MODES.map((mode) => ({
            label: accessLabels[mode],
            selected: mode === access,
            icon: (() => {
              const Icon = accessIcons[mode];
              return <Icon size={14} aria-hidden />;
            })(),
            onSelect: () => void setAccess(mode),
          }))}
        />
      ) : null}
      </div>
    </form>
  );
}
