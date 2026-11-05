import { AppWindow, FileCode, FileDiff, Quote, SquareTerminal, X } from "lucide-react";
import { chipLabel, chipsClipboard, type ComposerChip } from "./composerContext";

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
  chips,
  onRemove,
  onCopy,
}: {
  chips: readonly ComposerChip[];
  onRemove(id: string): void;
  onCopy(chips: readonly ComposerChip[]): void;
}) {
  if (chips.length === 0) return null;
  return (
    <ul className="context-chips" aria-label="Context chips">
      {chips.map((chip) => {
        const Icon = ICONS[chip.kind];
        return (
          <li key={chip.id} data-kind={chip.kind}>
            <Icon size={12} aria-hidden />
            <span title={chipLabel(chip)}>{chipLabel(chip)}</span>
            <button type="button" aria-label={`Copy ${chip.kind} chip`} onClick={() => onCopy([chip])}>
              Copy
            </button>
            <button type="button" aria-label={`Remove ${chip.kind} chip`} onClick={() => onRemove(chip.id)}>
              <X size={12} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
