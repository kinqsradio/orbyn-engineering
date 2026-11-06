import { Paperclip, X } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { api, request } from "../../api/client";
import type { Question, QuestionRequest } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { Button } from "../../ui/controls";
import { Markdown } from "./Markdown";

const POLL_MS = 1500;

const pending = (threadId: string, signal?: AbortSignal) =>
  request<QuestionRequest[]>(
    "GET",
    `/api/questions?thread_id=${encodeURIComponent(threadId)}&state=pending`,
    undefined,
    signal,
  );

function QuestionRow({
  question,
  picked,
  other,
  onPick,
  onOther,
}: {
  question: Question;
  picked: readonly string[];
  other: string;
  onPick(labels: string[]): void;
  onOther(text: string): void;
}) {
  return (
    <fieldset className="question">
      <legend className={question.header ? undefined : "sr-only"}>{question.header || question.question}</legend>
      <Markdown text={question.question} remoteImages="link" />
      <div className="question-options">
        {question.options.map((option, at) => {
          const on = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={on}
              data-option={at + 1}
              onClick={() =>
                onPick(
                  question.multi_select
                    ? on
                      ? picked.filter((label) => label !== option.label)
                      : [...picked, option.label]
                    : [option.label],
                )
              }
            >
              <kbd className="question-key" aria-hidden>
                {at + 1}
              </kbd>
              <strong>{option.label}</strong>
              {option.description ? <span>{option.description}</span> : null}
            </button>
          );
        })}
      </div>
      {question.allow_other || question.options.length === 0 ? (
        <input
          type={question.secret ? "password" : "text"}
          aria-label={question.question}
          placeholder={question.secret ? "Answer, not stored" : "Other answer"}
          value={other}
          autoComplete="off"
          onChange={(event) => onOther(event.target.value)}
        />
      ) : null}
    </fieldset>
  );
}

/** The engine is waiting on an answer. Dismissing tells it no answer is coming. */
export function QuestionPanel({ threadId, waiting }: { threadId: string; waiting: boolean }) {
  const list = useAsync(`questions:${threadId}:${waiting}`, (signal) =>
    waiting ? pending(threadId, signal) : Promise.resolve([]),
  );
  const { reload } = list;
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Files carried by a custom answer, kept per question. */
  const [files, setFiles] = useState<Record<string, { id: string; name: string }[]>>({});
  const [uploading, setUploading] = useState<string | null>(null);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, reload]);

  const open = list.data?.[0];
  if (!open) return null;

  const answers = Object.fromEntries(
    open.questions.map((question) => {
      const typed = others[question.id]?.trim();
      return [question.id, [...(picked[question.id] ?? []), ...(typed ? [typed] : [])]];
    }),
  );
  const complete = open.questions.every((question) => (answers[question.id]?.length ?? 0) > 0);
  const finish = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await request("POST", `/api/questions/${encodeURIComponent(open.id)}/${path}`, body);
      setPicked({});
      setOthers({});
      setFiles({});
      reload();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };
  const attach = async (questionId: string, file: File) => {
    setUploading(questionId);
    setError(null);
    try {
      const kept = await api.uploadAttachment(threadId, file);
      setFiles((current) => ({
        ...current,
        [questionId]: [...(current[questionId] ?? []), { id: kept.id, name: kept.name }],
      }));
    } catch (failure) {
      setError(`Couldn't attach that file. ${toFailure(failure).message}`);
    } finally {
      setUploading(null);
    }
  };
  const keptFiles = Object.fromEntries(
    Object.entries(files)
      .filter(([, list]) => list.length > 0)
      .map(([questionId, list]) => [questionId, list.map((entry) => entry.id)]),
  );

  return (
    <section
      className="question-panel"
      aria-label="Question from the agent"
      tabIndex={-1}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("select, textarea, input:not([type=radio]):not([type=checkbox])")) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (/^[1-9]$/.test(event.key)) {
          const group = target.closest("fieldset") ?? event.currentTarget.querySelector("fieldset");
          const option = group?.querySelector<HTMLButtonElement>(`button[data-option="${event.key}"]`);
          if (option) {
            event.preventDefault();
            option.click();
          }
          return;
        }
        // Enter submits only from the panel itself, its fieldset or a radio or checkbox option;
        // on a link, button or select it keeps its own meaning.
        const own =
          target === event.currentTarget ||
          target.tagName === "FIELDSET" ||
          (target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox"));
        if (event.key === "Enter" && own && complete && !busy && uploading === null) {
          event.preventDefault();
          void finish("answer", {
            answers,
            ...(Object.keys(keptFiles).length > 0 ? { attachments: keptFiles } : {}),
          });
        }
      }}
    >
      <p className="ask-label">
        <span className="status-dot" aria-hidden />
        The agent asks
      </p>
      {open.questions.map((question) => (
        <Fragment key={question.id}>
        <QuestionRow
          question={question}
          picked={picked[question.id] ?? []}
          other={others[question.id] ?? ""}
          onPick={(labels) => {
            setPicked((current) => ({ ...current, [question.id]: labels }));
            setOthers((current) => ({ ...current, [question.id]: "" }));
          }}
          onOther={(text) => {
            setOthers((current) => ({ ...current, [question.id]: text }));
            if (text.trim()) setPicked((current) => ({ ...current, [question.id]: [] }));
          }}
        />
        {(question.allow_other || question.options.length === 0) && !question.secret ? (
          <div className="question-files">
            {(files[question.id] ?? []).map((entry) => (
              <span key={entry.id} className="question-file">
                {entry.name}
                <button
                  type="button"
                  aria-label={`Remove ${entry.name}`}
                  onClick={() =>
                    setFiles((current) => ({
                      ...current,
                      [question.id]: (current[question.id] ?? []).filter((kept) => kept.id !== entry.id),
                    }))
                  }
                >
                  <X size={12} aria-hidden />
                </button>
              </span>
            ))}
            <label className="question-attach">
              <Paperclip size={12} aria-hidden />
              {uploading === question.id ? "Attaching..." : "Attach a file"}
              <input
                type="file"
                hidden
                aria-label={`Attach a file to ${question.question}`}
                disabled={uploading !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void attach(question.id, file);
                  event.target.value = "";
                }}
              />
            </label>
          </div>          ) : null}
        </Fragment>
      ))}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="question-actions">
        <Button small tone="quiet" disabled={busy} onClick={() => void finish("dismiss")}>
          Dismiss
        </Button>
        <Button
          small
          tone="primary"
          disabled={busy || !complete || uploading !== null}
          onClick={() =>
            void finish("answer", {
              answers,
              ...(Object.keys(keptFiles).length > 0 ? { attachments: keptFiles } : {}),
            })
          }
        >
          Submit answers
        </Button>
      </div>
    </section>
  );
}
