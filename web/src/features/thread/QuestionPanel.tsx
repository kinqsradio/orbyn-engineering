import { useEffect, useState } from "react";
import { request } from "../../api/client";
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
      <Markdown text={question.question} />
      <div className="question-options">
        {question.options.map((option) => {
          const on = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={on}
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
      reload();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="question-panel" aria-label="Question from the agent">
      {open.questions.map((question) => (
        <QuestionRow
          key={question.id}
          question={question}
          picked={picked[question.id] ?? []}
          other={others[question.id] ?? ""}
          onPick={(labels) => setPicked({ ...picked, [question.id]: labels })}
          onOther={(text) => setOthers({ ...others, [question.id]: text })}
        />
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
        <Button small tone="primary" disabled={busy || !complete} onClick={() => void finish("answer", { answers })}>
          Submit answers
        </Button>
      </div>
    </section>
  );
}
