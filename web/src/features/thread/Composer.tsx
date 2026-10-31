import { composerMarkup } from "./composerMarkup";
import { ArrowUp, Archive, Folder, GitBranch, ListChecks, Paperclip, ShieldOff, SlidersHorizontal, Square, X,
  RotateCcw,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { api } from "../../api/client";
import { useCommand as useSharedCommand } from "../../app/shortcuts";
import type { EngineStatus, PermissionMode, Thread } from "../../api/types";
import { useLayoutWidth } from "../../lib/useLayout";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useDraftStore } from "../onboarding/draftStore";
import { navigate } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi, type StashedPrompt } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { Menu } from "../../ui/Menu";
import { useWorkspace } from "../../state/workspace";
import { ComposerBanners, ContextMeter, InlineLimits, StashDrawer, StopNotice } from "./ComposerExtras";
import {
  continueListLine,
  indentListLine,
  LARGE_PASTE_BYTES,
  localCommand,
  promptHistory,
  recallStep,
  type RecallPosition,
} from "./composerInput";
import { ACCESS, EffortTrigger, useTraitsMenu } from "./ComposerTraits";
import { ModelPickerTrigger } from "./ModelPicker";
import { QuestionPanel } from "./QuestionPanel";
import { effortOption, effortValue, resolveModel, useEngineModels } from "./modelStore";
import { QueuedMessages } from "./QueuedMessages";
import { openSideChat } from "../panels/sideChat";
import { pullsApi } from "../pulls/pullsApi";
import { insertToken, pullToken, threadToken, triggerAt } from "./skillMention";

interface Suggestion {
  value: string;
  detail: string | null;
  /** What goes in the prompt, when it isn't the trigger and the value. */
  insert?: string;
}

/** A file on its way to the service: `id` once kept, `failure` if it was refused. */
interface ShownAttachment {
  key: string;
  file: File;
  name: string;
  /** An object URL for images added here, so the shelf can show them. */
  preview: string | null;
  id: string | null;
  failure: string | null;
}

/** The service refuses longer messages; here the draft stays and says so first. */
const MAX_PROMPT_CHARS = 120_000;
/** Past this a keystroke would lag behind the styling, so the text stays plain. */
const STYLED_CHARS = 20_000;
const charactersOver = (text: string) => (text.length <= MAX_PROMPT_CHARS ? 0 : Math.max([...text].length - MAX_PROMPT_CHARS, 0));

/** Commands go to the thread's own composer; a side chat's stays out of their way. */
const useOwnCommand = (side: boolean, command: string, handler: () => boolean | void) =>
  useSharedCommand(command, () => (side ? false : handler()));

const NO_STASHES: StashedPrompt[] = [];
const effortButton = () => document.querySelector<HTMLElement>("[data-effort-trigger]");
const LOCAL_COMMANDS: Suggestion[] = [
  { value: "plan", detail: "Switch to Plan" },
  { value: "default", detail: "Switch back to Build" },
  { value: "usage-limits", detail: "Show usage limits" },
  { value: "side", detail: "Ask in a side chat" },
  { value: "btw", detail: "Ask in a side chat" },
];
const PLAN_COMMANDS = new Set(["plan", "default"]);
/** Below this the footer's controls fold into one menu. */
const NARROW_BAR = 440;
const WIDE = 1000;
const MENU_LIFT = 150;
const MAX_HEIGHT_RATIO = 0.4;
const MENU_ROWS = 6;

export function Composer({
  thread,
  engine,
  beforeSend,
  onSendFailed,
  showContext,
  side = false,
}: {
  thread: Thread;
  engine: EngineStatus | null;
  /** Runs first and may hold the send, as the hero transition does. */
  beforeSend?(): Promise<void>;
  onSendFailed?(): void;
  /** The checkout, branch and access row, shown when nothing else carries them. */
  showContext: boolean;
  /** This composer belongs to a side chat in the panel. */
  side?: boolean;
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
  const [attachments, setAttachments] = useState<ShownAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recall, setRecall] = useState<RecallPosition | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const shiftPaste = useRef(false);
  const bar = useRef<HTMLDivElement>(null);
  const [narrowBar, setNarrowBar] = useState(false);
  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null);
  const openOverflow = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setOverflow({ x: rect.left, y: rect.top - MENU_LIFT });
  };
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrowBar((entry?.contentRect.width ?? WIDE) < NARROW_BAR));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const caretAfterEdit = useRef<number | null>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const followUpBehavior = useUi((state) => state.followUpBehavior);
  const sendShortcut = useUi((state) => state.sendShortcut);
  const persistentContext = useUi((state) => state.persistentComposerContext);
  const skillsInSlash = useUi((state) => state.skillsInSlashMenu);
  const planControls = useUi((state) => state.planControls);
  const contextMeter = useUi((state) => state.contextMeter);
  const stashes = useUi((state) => state.stashes[thread.id] ?? NO_STASHES);
  const log = useThreadLogs((state) => state.logs[thread.id]);
  const history = useMemo(() => promptHistory(log?.items ?? []), [log]);
  const [stopping, setStopping] = useState(false);
  const [stoppedRun, setStoppedRun] = useState<string | null>(null);
  const refreshAll = useWorkspace((state) => state.refreshAll);
  const filePicker = useRef<HTMLInputElement>(null);
  const putThread = useWorkspace((state) => state.putThread);
  const projectBranch = useWorkspace(
    (state) => state.managed.data?.targets.find((t) => t.project_id === thread.project_id)?.branch ?? null,
  );
  const branch = thread.worktree?.branch ?? projectBranch;
  const busy = thread.active_run !== null;
  const uploading = attachments.some((file) => file.id === null);
  const overBy = charactersOver(draft);
  const styled = useMemo(() => (draft && draft.length <= STYLED_CHARS ? composerMarkup(draft) : null), [draft]);
  const canSend = draft.trim() !== "" && !sending && !uploading && overBy === 0;
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
      const local = LOCAL_COMMANDS.filter(
        (command) => command.value.includes(needle) && (planControls || !PLAN_COMMANDS.has(command.value)),
      );
      const skills = skillsInSlash ? (await api.mentions(thread.id, trigger.query, signal)).skills : [];
      return [
        ...local,
        ...commands
          .filter((command) => command.name.toLowerCase().includes(needle))
          .map((command) => ({ value: command.name, detail: command.description })),
        ...skills.map((value) => ({ value, detail: "Skill" })),
      ];
    }
    if (trigger.char === "#") {
      const digits = /^\d+$/.test(trigger.query);
      const pulls = await pullsApi.projectPulls(thread.project_id, digits ? "" : trigger.query, signal);
      return pulls
        .filter((pull) => !digits || String(pull.number).includes(trigger.query))
        .map((pull) => ({
          value: String(pull.number),
          detail: pull.title,
          insert: pullToken(pull.number, pull.title, pull.url),
        }));
    }
    const found = await api.mentions(thread.id, trigger.query, signal);
    if (trigger.char === "$") return found.skills.map((value) => ({ value, detail: null }));
    const threads = found.threads.map((other) => ({
      value: other.title,
      detail: "Thread",
      insert: threadToken(other.id, other.title),
    }));
    const files = found.files.slice(0, Math.max(MENU_ROWS - threads.length, 2));
    return [...files.map((value) => ({ value, detail: null })), ...threads];
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
    // Before the next paint, so a key pressed right after lands at the caret.
    if (caretAfterEdit.current !== null) element.setSelectionRange(caretAfterEdit.current, caretAfterEdit.current);
    caretAfterEdit.current = null;
    if (mirror.current) mirror.current.scrollTop = element.scrollTop;
  }, [draft]);

  const pick = (suggestion: Suggestion) => {
    if (!trigger) return;
    if (runLocal(`/${suggestion.value}`)) return;
    const next = insertToken(draft, caret, trigger, suggestion.value, suggestion.insert);
    setDraft(thread.id, next.text);
    setCaret(next.caret);
    caretAfterEdit.current = next.caret;
  };

  const setPlanMode = async (on: boolean) => {
    setError(null);
    try {
      putThread(await api.patchThread(thread.id, { plan_mode: on }));
    } catch (failure) {
      setError(`Couldn't change the mode. ${toFailure(failure).message}`);
    }
  };

  /** Handles what the composer does itself; the agent never sees these. */
  const runLocal = (text: string): boolean => {
    const command = localCommand(text);
    if (!command) return false;
    setDraft(thread.id, "");
    if (command === "plan") void setPlanMode(true);
    if (command === "default") void setPlanMode(false);
    if (command === "usage-limits") setLimitsOpen(true);
    return true;
  };

  const send = async (followUp: "default" | "opposite" = "default") => {
    if (!canSend) return false;
    const prompt = draft;
    if (runLocal(prompt)) return false;
    const sideChat = side ? null : /^\/(?:side|btw)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (sideChat) {
      setDraft(thread.id, "");
      void openSideChat(thread, sideChat[1]?.trim() || null);
      return false;
    }
    const queued = followUpBehavior === "queue";
    const steering = busy && (followUp === "default" ? !queued : queued);
    setSending(true);
    setError(null);
    try {
      await beforeSend?.();
      // Claude hears a typed reply as the reason it was declined, so nothing is queued.
      if (pendingHere.length > 0 && engine?.capabilities.decline_feedback) {
        await Promise.all(pendingHere.map((approval) => api.decideApproval(approval.id, false, false, prompt.trim())));
        setDraft(thread.id, "");
        void refreshThread(thread.id);
        return true;
      }
      await Promise.all(pendingHere.map((approval) => api.decideApproval(approval.id, false, false)));
      const ids = attachments.flatMap((file) => file.id ?? []);
      const run = busy ? null : await api.startRun(thread.id, prompt.trim(), ids);
      if (steering) {
        const steered = await api.steer(thread.id, prompt.trim());
        if (steered.state === "queued") useUi.getState().pushToast("This engine reads it on its next turn");
      } else if (busy) await api.enqueue(thread.id, prompt.trim(), ids);
      setAttachments([]);
      setRecall(null);
      // Text typed after pressing Send stays; only what was sent is removed.
      const current = useUi.getState().drafts[thread.id] ?? "";
      setDraft(thread.id, current === prompt ? "" : current);
      if (run) addPrompt(thread.id, { runId: run.id, text: prompt.trim() });
      if (busy) reloadQueue();
      void refreshThread(thread.id);
      return true;
    } catch (failure) {
      onSendFailed?.();
      const known = toFailure(failure);
      if (known.code === "folder_untrusted") {
        navigate({ name: "trust", projectId: thread.project_id, threadId: thread.id });
        return false;
      }
      setError(
        known.code === "thread_busy"
          ? "A run started first. Your message is kept, so send it again to queue it."
          : steering
            ? `Couldn't steer. ${known.message} Your message is kept.`
            : `Couldn't start the run. ${known.message} Your message is kept.`,
      );
      void refreshThread(thread.id);
      return false;
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
    if (event.nativeEvent.isComposing) return;
    shiftPaste.current = event.shiftKey && event.key.toLowerCase() === "v";
    const element = event.currentTarget;
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const edge = event.key === "ArrowUp" ? element.selectionStart === 0 : element.selectionEnd === draft.length;
      const step = edge ? recallStep(history, recall, draft, event.key === "ArrowUp" ? -1 : 1) : null;
      if (step) {
        event.preventDefault();
        setRecall(step.position);
        setDraft(thread.id, step.text);
      }
      return;
    }
    if (event.key === "Tab" && !menuOpen) {
      const next = indentListLine(draft, element.selectionStart, event.shiftKey);
      if (next) {
        event.preventDefault();
        setDraft(thread.id, next.text);
        caretAfterEdit.current = next.caret;
        return;
      }
      if (event.shiftKey && planControls && !busy && thread.lifecycle) {
        event.preventDefault();
        void setPlanMode(!planMode);
        return;
      }
    }
    if (event.key !== "Enter") return;
    // Left to the shell, whose rule sends and opens a new thread.
    if (event.altKey && (event.metaKey || event.ctrlKey)) return;
    if (event.shiftKey && !event.metaKey && !event.ctrlKey) {
      const next = continueListLine(draft, element.selectionStart);
      if (next) {
        event.preventDefault();
        setDraft(thread.id, next.text);
        caretAfterEdit.current = next.caret;
      }
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const multiline = draft.includes("\n");
    const enterSends = sendShortcut === "enter" || (sendShortcut === "mod-enter-multiline" && !multiline);
    if (!enterSends && !mod) return;
    event.preventDefault();
    void send(busy && (enterSends ? mod : event.shiftKey) ? "opposite" : "default");
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      upload(files);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text.length >= LARGE_PASTE_BYTES && !shiftPaste.current) {
      event.preventDefault();
      upload([new File([text], "pasted-text.txt", { type: "text/plain" })]);
    }
    shiftPaste.current = false;
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) upload([...event.dataTransfer.files]);
  };

  const droppedHere = useDraftStore((state) => state.dropped[thread.id]);
  useEffect(() => {
    if (!droppedHere) return;
    upload(useDraftStore.getState().takeDropped(thread.id));
  });

  const stash = () => {
    const stored = useUi.getState().stashes;
    const list = stored[thread.id] ?? [];
    const { setPrefs: save } = useUi.getState();
    if (draft.trim()) {
      const entry = { id: crypto.randomUUID(), text: draft, at: new Date().toISOString() };
      save({ stashes: { ...stored, [thread.id]: [entry, ...list] } });
      setDraft(thread.id, "");
      useUi.getState().pushToast("Prompt stashed");
    } else if (list.length === 1 && list[0]) {
      restoreStash(list[0].id);
    } else if (list.length > 1) {
      setStashOpen(true);
    }
  };

  const dropStash = (id: string) => {
    const stored = useUi.getState().stashes;
    useUi.getState().setPrefs({
      stashes: { ...stored, [thread.id]: (stored[thread.id] ?? []).filter((entry) => entry.id !== id) },
    });
  };

  const restoreStash = (id: string) => {
    const entry = stashes.find((candidate) => candidate.id === id);
    if (!entry) return;
    setDraft(thread.id, entry.text);
    dropStash(id);
    setStashOpen(false);
    field.current?.focus();
  };

  useOwnCommand(side, "composer.stash", () => {
    stash();
  });
  useOwnCommand(side, "composer.sendAndNewThread", () => {
    if (!canSend) return false;
    void send().then((sent) => {
      if (sent) navigate({ name: "new", projectId: thread.scratch ? null : thread.project_id });
    });
  });
  useOwnCommand(side, "thread.steerQueuedMessage", () => {
    const oldest = queue.data?.[0];
    if (!oldest || !busy) return false;
    void api
      .steer(thread.id, oldest.prompt)
      .then(() => api.removeQueued(oldest.id))
      .then(reloadQueue, (failure: unknown) => setError(`Couldn't steer. ${toFailure(failure).message}`));
  });

  const startUpload = (entry: ShownAttachment) => {
    const settle = (patch: Partial<ShownAttachment>) =>
      setAttachments((current) => current.map((file) => (file.key === entry.key ? { ...file, ...patch } : file)));
    settle({ failure: null });
    api.uploadAttachment(thread.id, entry.file).then(
      (kept) => settle({ id: kept.id, name: kept.name }),
      (failure: unknown) => settle({ failure: toFailure(failure).message }),
    );
  };

  /** Each file starts at once and ends up kept or refused on its own. */
  const upload = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const added = [...files].map((file) => ({
      key: crypto.randomUUID(),
      file,
      name: file.name,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      id: null,
      failure: null,
    }));
    setAttachments((current) => [...current, ...added]);
    added.forEach(startUpload);
    if (filePicker.current) filePicker.current.value = "";
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
      setStoppedRun(thread.active_run.id);
      void refreshAll();
    } catch (failure) {
      setError(`Couldn't stop the run. ${toFailure(failure).message}`);
    } finally {
      setStopping(false);
    }
  };

  const unmanaged = engine !== null && !engine.capabilities.managed;
  const planMode = thread.lifecycle?.plan_mode ?? false;
  const access = thread.lifecycle?.permission_mode ?? "supervised";
  const AccessIcon = ACCESS[access].icon;
  const engineName = engine?.name ?? thread.engine;
  const allEngines = useWorkspace((state) => state.engines.data);
  const installed = useMemo(() => (allEngines ?? []).filter((entry) => entry.installed), [allEngines]);
  const models = useEngineModels(thread.engine);
  const model = resolveModel(models, thread.model);
  const setPrefs = useUi((state) => state.setPrefs);
  const setEffort = async (effort: string) => {
    setError(null);
    try {
      putThread(await api.patchThread(thread.id, { effort }));
      setPrefs({ lastModel: { engine: thread.engine, model: thread.model, effort } });
    } catch (failure) {
      setError(`Couldn't change the effort. ${toFailure(failure).message}`);
    }
  };
  const pickModel = async (next: { engine: string; model: string | null }) => {
    setError(null);
    try {
      const updated =
        next.engine === thread.engine
          ? await api.patchThread(thread.id, next.model ? { model: next.model } : {})
          : await api.switchEngine(thread.id, next.engine, next.model);
      putThread(updated);
      setPrefs({ lastModel: { ...next, effort: updated.effort ?? null } });
    } catch (failure) {
      setError(`Couldn't change the model. ${toFailure(failure).message}`);
    }
  };
  useOwnCommand(side, "thread.editQueuedMessage", () => {
    const last = queue.data?.at(-1);
    if (!last) return false;
    void api.removeQueued(last.id).then(() => {
      setDraft(thread.id, last.prompt);
      reloadQueue();
    });
  });

  useOwnCommand(side, "composer.effort", () => {
    const trigger = effortButton();
    if (!trigger) return false;
    traits.openAt(trigger, false);
  });

  useOwnCommand(side, "composer.mode", () => {
    const trigger = effortButton();
    if (!trigger || unmanaged) return false;
    traits.openAt(trigger, true);
  });
  const stepEffort = (step: 1 | -1) => {
    const values = effortOption(model)?.values ?? [];
    if (values.length === 0 || busy) return false;
    const at = values.findIndex((value) => value.id === effortValue(model, thread.effort ?? null)?.id);
    const next = values[(Math.max(at, 0) + step + values.length) % values.length];
    if (next) void setEffort(next.id);
    return true;
  };
  useOwnCommand(side, "composer.increaseEffort", () => stepEffort(1));
  useOwnCommand(side, "composer.decreaseEffort", () => stepEffort(-1));
  const traits = useTraitsMenu({
    model,
    effort: thread.effort ?? null,
    extras: thread.options ?? {},
    access: unmanaged ? null : access,
    onEffort: (value) => void setEffort(value),
    onOption: (option, value) => {
      setError(null);
      api.patchThread(thread.id, { options: { [option]: value } }).then(putThread, (failure: unknown) => {
        setError(`Couldn't change that. ${toFailure(failure).message}`);
      });
    },
    onAccess: (mode) => void setAccess(mode),
  });

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
      <QueuedMessages
        threadId={thread.id}
        items={queue.data ?? []}
        running={busy}
        onChange={reloadQueue}
        onEdit={(prompt) => setDraft(thread.id, draft.trim() ? `${draft}\n\n${prompt}` : prompt)}
      />
      <QuestionPanel threadId={thread.id} waiting={thread.active_run?.state === "awaiting_approval"} />
      <ComposerBanners engine={engine} />
      {runId !== null && runId === stoppedRun ? <StopNotice threadId={thread.id} runId={runId} /> : null}
      {limitsOpen ? <InlineLimits threadId={thread.id} onClose={() => setLimitsOpen(false)} /> : null}
      {stashOpen ? (
        <StashDrawer entries={stashes} onRestore={restoreStash} onDelete={dropStash} onClose={() => setStashOpen(false)} />
      ) : null}
      <div
        className="composer-box"
        data-dragging={dragging || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
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
              <li key={file.key} data-failed={file.failure !== null || undefined}>
                {file.preview ? <img src={file.preview} alt="" className="attachment-thumb" /> : null}
                <span title={file.failure ?? undefined}>{file.name}</span>
                {file.failure ? (
                  <>
                    <span className="attachment-failure" role="alert">
                      {file.failure}
                    </span>
                    <button type="button" aria-label={`Retry ${file.name}`} onClick={() => startUpload(file)}>
                      <RotateCcw size={12} aria-hidden />
                    </button>
                  </>
                ) : file.id === null ? (
                  <span className="sr-only" role="status">
                    Uploading
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setAttachments(attachments.filter((entry) => entry.key !== file.key))}
                >
                  <X size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {overBy > 0 ? (
          <p className="composer-over" role="alert">
            {overBy.toLocaleString()} characters over the {MAX_PROMPT_CHARS.toLocaleString()} limit. Your message stays here.
          </p>
        ) : null}
        <div className="composer-field">
        {styled ? (
          <div ref={mirror} className="composer-mirror" aria-hidden>
            {styled.map((span, at) => (
              <span key={at} data-md={span.kind === "text" ? undefined : span.kind}>
                {span.text}
              </span>
            ))}
            {"\n"}
          </div>
        ) : null}
        <textarea
          ref={field}
          data-styled={styled ? true : undefined}
          onScroll={(event) => {
            if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
          }}
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
          onPaste={onPaste}
          dir="auto"
          aria-label={`Message ${thread.title}`}
          aria-describedby="composer-help"
          placeholder={
            pendingHere.length > 0
              ? engine?.capabilities.decline_feedback
                ? "Type a reply to decline with feedback"
                : "Send a message to decline and redirect the agent"
              : "Ask anything. @ files, $ skills, / commands"
          }
          data-autofocus={layout === "narrow" ? undefined : true}
        />
        </div>
        <span id="composer-help" className="sr-only">
          Enter to send, Shift+Enter for a new line
        </span>
        <div ref={bar} className="composer-bar">
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            aria-label="Attach files"
            onChange={(event) => upload(event.target.files)}
          />
          <IconButton
            label="Attach files"
            onClick={() => filePicker.current?.click()}
          >
            <Paperclip size={16} aria-hidden />
          </IconButton>
          {stashes.length > 0 ? (
            <button
              type="button"
              className="composer-control"
              aria-label={`${stashes.length} stashed prompts`}
              onClick={() => setStashOpen(!stashOpen)}
            >
              <Archive size={14} aria-hidden />
              <span>{stashes.length}</span>
            </button>
          ) : null}
          {(planControls || planMode) && !narrowBar ? (
            <button
              type="button"
              className="composer-control"
              aria-pressed={planMode}
              data-on={planMode || undefined}
              disabled={busy || !thread.lifecycle}
              onClick={() => void setPlanMode(!planMode)}
            >
              <ListChecks size={14} aria-hidden />
              <span>Plan</span>
            </button>
          ) : null}
          <span className="composer-spacer" />
          {contextMeter ? <ContextMeter threadId={thread.id} disabled={busy} /> : null}
          {narrowBar ? (
            <IconButton label="Composer controls" onClick={(event) => openOverflow(event.currentTarget)}>
              <SlidersHorizontal size={16} aria-hidden />
            </IconButton>
          ) : null}
          <span className="composer-controls" data-folded={narrowBar || undefined}>
          {engine ? (
            <ModelPickerTrigger
              engines={installed}
              selected={{ engine: thread.engine, model: thread.model }}
              disabled={busy}
              onPick={(next) => void pickModel(next)}
            />
          ) : (
            <span className="composer-control">{thread.model ?? engineName}</span>
          )}
          <EffortTrigger
            model={model}
            effort={thread.effort ?? null}
            access={unmanaged ? null : access}
            disabled={busy}
            onOpen={(element) => traits.openAt(element, false)}
          />
          {!showContext && !unmanaged ? (
            <button
              type="button"
              className="composer-control composer-access"
              aria-haspopup="menu"
              aria-label={`Permissions: ${ACCESS[access].label}`}
              disabled={busy || !thread.lifecycle}
              onClick={(event) => traits.openAt(event.currentTarget, true)}
            >
              <AccessIcon size={14} aria-hidden />
              <span>{ACCESS[access].label}</span>
            </button>
          ) : null}
          </span>
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
      <div className="composer-context" hidden={!showContext && !persistentContext}>
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
                  aria-label={`Permissions: ${ACCESS[access].label}`}
                  disabled={busy || !thread.lifecycle}
                  onClick={(event) => traits.openAt(event.currentTarget, true)}
                >
                  <AccessIcon size={12} aria-hidden />
                  {ACCESS[access].label}
                </button>
              )}
            </dd>
          </div>
        </dl>
      </div>
      {traits.menu}
      {overflow ? (
        <Menu
          x={overflow.x}
          y={overflow.y}
          label="Composer controls"
          onClose={() => setOverflow(null)}
          items={[
            {
              label: model?.label ?? thread.model ?? engineName,
              disabled: busy,
              onSelect: () => document.querySelector<HTMLElement>("form.composer [data-model-trigger]")?.click(),
            },
            {
              label: "Effort",
              disabled: busy,
              onSelect: () => {
                const trigger = effortButton();
                if (trigger) traits.openAt(trigger, false);
              },
            },
            ...(unmanaged
              ? []
              : [
                  {
                    label: `Permissions: ${ACCESS[access].label}`,
                    disabled: busy,
                    onSelect: () => {
                      const trigger = effortButton();
                      if (trigger) traits.openAt(trigger, true);
                    },
                  },
                ]),
            ...(planControls
              ? [{ label: "Plan", selected: planMode, disabled: busy, onSelect: () => void setPlanMode(!planMode) }]
              : []),
          ]}
        />
      ) : null}
      </div>
    </form>
  );
}
