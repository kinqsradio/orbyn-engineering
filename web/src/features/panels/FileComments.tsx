import { useState } from "react";
import { useComposerChips } from "../../state/composerChips";
import { useUi } from "../../state/ui";
import { Button } from "../../ui/controls";
import { CHIP_EXCERPT_LIMIT, charactersOver, chipId, chipLabel, promptWithChips } from "../thread/composerContext";

/** A range captures exactly the displayed lines, never a second filesystem read. */
export function fileCommentRange(text: string, start: number, end: number) {
  const rows = text.split("\n");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  const line = Math.min(start, end);
  const endLine = Math.max(start, end);
  if (line < 1 || endLine > rows.length) return null;
  const excerpt = rows.slice(line - 1, endLine).join("\n");
  if (excerpt.length > CHIP_EXCERPT_LIMIT) return null;
  return { line, endLine, excerpt };
}

/** Line annotations only change composer context; source bytes remain untouched. */
export function FileComments({ threadId, cwd, path, revision, text, revealedLine }: {
  threadId: string; cwd: string; path: string; revision: string; text: string; revealedLine: number | null;
}) {
  const [selection, setSelection] = useState<{ anchor: number; end: number } | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const all = useComposerChips((state) => state.chips[threadId]);
  const comments = (all ?? []).filter((chip) => chip.kind === "review" && chip.path === path
    && chip.sourceRevision === revision && chip.sourceCwd === cwd);
  const range = selection ? fileCommentRange(text, selection.anchor, selection.end) : null;
  const cancel = () => { setSelection(null); setComment(""); setError(null); };
  const submit = () => {
    if (!range || !comment.trim()) return;
    const chip = { id: chipId(), kind: "review" as const, path, ...range,
      comment: comment.trim(), sourceRevision: revision, sourceCwd: cwd };
    const chips = useComposerChips.getState().chips[threadId] ?? [];
    if (charactersOver(promptWithChips(useUi.getState().drafts[threadId] ?? "", [...chips, chip]))) {
      setError("This comment would make your message too long. Shorten it before adding it.");
      return;
    }
    useComposerChips.getState().add(threadId, chip);
    useUi.getState().pushToast("Review comment added to your message");
    cancel();
  };
  return <>
    <p className="file-comment-hint">Select a line to comment. Shift-select another line for a range.</p>
    <pre className="file-source file-comment-source" tabIndex={0} ref={(element) => {
      element?.querySelector("[data-line]")?.scrollIntoView?.({ block: "center" });
    }}>
      {text.split("\n").map((row, index) => {
        const line = index + 1;
        const selected = selection && line >= Math.min(selection.anchor, selection.end) && line <= Math.max(selection.anchor, selection.end);
        return <span key={line} data-line={line === revealedLine || undefined} data-selected={selected || undefined}>
          <button type="button" aria-label={`Comment on line ${line}`} aria-pressed={Boolean(selected)} onClick={(event) => {
            setSelection((current) => ({ anchor: event.shiftKey && current ? current.anchor : line, end: line }));
            setError(null);
          }}>{line}</button>{row}{"\n"}
        </span>;
      })}
    </pre>
    {selection ? <form className="file-comment-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <label>Comment on {path}:{Math.min(selection.anchor, selection.end)}{selection.anchor !== selection.end ? `–${Math.max(selection.anchor, selection.end)}` : ""}
        <textarea aria-label="File comment" value={comment} maxLength={20000} onChange={(event) => setComment(event.target.value)} autoFocus />
      </label>
      {!range ? <p role="alert">Select at most 4,000 characters of source for a comment.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div><Button onClick={cancel}>Cancel</Button><Button type="submit" disabled={!range || !comment.trim()}>Add comment</Button></div>
    </form> : null}
    {comments.length ? <ul className="file-comment-list" aria-label="File comments">
      {comments.map((chip) => <li key={chip.id}>
        <strong>{chipLabel(chip)}</strong><p>{chip.kind === "review" ? chip.comment : ""}</p>
        <Button small tone="quiet" onClick={() => useComposerChips.getState().remove(threadId, chip.id)}>Remove comment</Button>
      </li>)}
    </ul> : null}
  </>;
}
