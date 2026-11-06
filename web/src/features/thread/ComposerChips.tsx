import { AppWindow, FileCode, FileDiff, Quote, SquareTerminal, X } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/controls";
import { useComposerChips } from "../../state/composer/composerChipStore";
import { chipLabel, chipsClipboard, type ComposerChip, type ReviewChip } from "../../state/composer/composerContext";

const ICONS = {
  file: FileCode,
  terminal: SquareTerminal,
  review: FileDiff,
  annotation: AppWindow,
  citation: Quote,
} as const;

/**
 * Puts chips on the clipboard in every form they have: Orbyn's JSON so another
 * composer restores them, HTML for rich targets and plain prompt blocks for the
 * rest. A browser without `ClipboardItem` still writes the plain text.
 */
export async function copyChips(chips: readonly ComposerChip[]): Promise<boolean> {
  const payload = chipsClipboard(chips);
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!payload || !clipboard) return false;
  try {
    if (typeof ClipboardItem !== "undefined" && clipboard.write) {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
          "text/html": new Blob([payload.html], { type: "text/html" }),
        }),
      ]);
    } else if (clipboard.writeText) {
      await clipboard.writeText(payload.text);
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The chips waiting above a composer, each one removable and copyable. */
export function ComposerChipShelf({
  threadId,
  chips,
  onRemove,
  onCopy,
  onUpdate,
}: {
  threadId: string;
  chips: readonly ComposerChip[];
  onRemove(id: string): void;
  onCopy(chips: readonly ComposerChip[]): void;
  onUpdate?(chip: ReviewChip): boolean;
}) {
  const draft = useComposerChips((state) => state.reviewDrafts[threadId]);
  const setDraft = (value: { chipId: string; text: string } | undefined) => useComposerChips.getState().setReviewDraft(threadId, value);
  const review = chips.find((chip): chip is ReviewChip => chip.id === draft?.chipId && chip.kind === "review");
  if (chips.length === 0) return null;
  return (
    <><ul className="context-chips" aria-label="Context chips">
      {chips.map((chip) => {
        const Icon = ICONS[chip.kind];
        return (
          <li key={chip.id} data-kind={chip.kind}>
            <Icon size={12} aria-hidden />
            {chip.kind === "review" ? <button type="button" className="review-chip-label" onClick={() => setDraft({ chipId: chip.id, text: chip.comment })}
              aria-label={`Review comment ${chipLabel(chip)}`}>{chipLabel(chip)}</button>
              : <span title={chipLabel(chip)}>{chipLabel(chip)}</span>}
            <button type="button" aria-label={`Copy ${chip.kind} chip`} onClick={() => onCopy([chip])}>
              Copy
            </button>
            <button type="button" aria-label={`Remove ${chip.kind} chip`} onClick={() => onRemove(chip.id)}>
              <X size={12} aria-hidden />
            </button>
          </li>
        );
      })}
      {chips.length > 1 ? (
        <li className="context-chips-all">
          <button type="button" aria-label="Copy all chips" onClick={() => onCopy(chips)}>
            Copy all
          </button>
        </li>
      ) : null}
    </ul>
      {review && draft ? <ReviewDetails key={review.id} threadId={threadId} chip={review} comment={draft.text}
        onComment={(text) => setDraft({ chipId: review.id, text })} onClose={() => setDraft(undefined)}
        onSave={onUpdate} onRemove={() => { onRemove(review.id); setDraft(undefined); }} /> : null}
    </>
  );
}

function ReviewDetails({ threadId, chip, comment, onComment, onClose, onSave, onRemove }: {
  threadId: string;
  chip: ReviewChip; onClose(): void; onSave?: (chip: ReviewChip) => boolean; onRemove(): void;
  comment: string; onComment(text: string): void;
}) {
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => {
    // Dialog first tries its opener and the page heading. Both can be inside
    // the hidden thread when Files takes over; restore a visible local fallback.
    // Escape's native dialog focus restoration can finish after microtasks.
    // Wait for the next layout frame before choosing a still-visible fallback.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body
        && !active.closest("[hidden]") && active.getClientRects().length > 0) return;
      const viewer = [...document.querySelectorAll<HTMLElement>(".files-viewer")]
        .find((element) => element.dataset.threadId === threadId
          && !element.closest("[hidden]") && element.getClientRects().length > 0);
      viewer?.querySelector<HTMLButtonElement>(".panel-bar button")?.focus();
    });
  }, [threadId]);
  // The thread can be hidden while Files occupies the viewport. Keep the modal
  // outside that hidden ancestor without moving its thread-scoped edit state.
  return createPortal(<Dialog title={`Review comment ${chipLabel(chip)}`} onClose={onClose} footer={<>
    <Button tone="danger" onClick={onRemove}>Remove comment</Button>
    <Button onClick={onClose}>Cancel</Button>
    {onSave ? <Button disabled={!comment.trim()} onClick={() => {
      if (onSave({ ...chip, comment: comment.trim() })) onClose();
      else setError("This comment would make your message too long. Shorten it before saving.");
    }}>Save comment</Button> : null}
  </>}>
    {chip.excerpt !== null ? <pre className="review-chip-excerpt" tabIndex={0}>{chip.excerpt}</pre> : null}
    <label>Comment<textarea aria-label="Review comment" maxLength={20000} value={comment}
      readOnly={!onSave} onChange={(event) => onComment(event.target.value)} /></label>
    {error ? <p role="alert">{error}</p> : null}
  </Dialog>, document.body);
}
