import type { ThreadItem } from "./projection";

export const LARGE_PASTE_BYTES = 32 * 1024;

const LOCAL = new Set(["plan", "default", "usage-limits"]);

/** `/plan` and friends act on the composer rather than reaching the agent. */
export function localCommand(text: string): string | null {
  const match = /^\/([a-z-]+)\s*$/.exec(text.trim());
  return match?.[1] && LOCAL.has(match[1]) ? match[1] : null;
}

export const promptHistory = (items: readonly ThreadItem[]): string[] =>
  items.flatMap((item) => (item.kind === "message" && item.role === "user" ? [item.text] : []));

export interface RecallPosition {
  index: number;
  text: string;
}

/**
 * ArrowUp in an empty composer walks back through sent prompts, ArrowDown forward.
 * Recall takes over only while the text is still the unedited recalled prompt.
 */
export function recallStep(
  history: readonly string[],
  position: RecallPosition | null,
  draft: string,
  step: -1 | 1,
): { position: RecallPosition | null; text: string } | null {
  const active = position !== null && position.text === draft ? position.index : null;
  if (active === null) {
    if (draft !== "" || step === 1) return null;
    const index = history.length - 1;
    const text = history[index];
    return text === undefined ? null : { position: { index, text }, text };
  }
  const index = active + step;
  if (index < 0) return null;
  const text = history[index];
  return text === undefined ? { position: null, text: "" } : { position: { index, text }, text };
}

const LIST = /^(\s*)([-*+]|\d+[.)]|>)(\s+)(\[[ x]\]\s+)?/;

const lineBounds = (text: string, caret: number) => {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const next = text.indexOf("\n", caret);
  return { start, end: next === -1 ? text.length : next };
};

/** Shift+Enter carries a list or quote marker onto the next line. */
export function continueListLine(text: string, caret: number): { text: string; caret: number } | null {
  const { start, end } = lineBounds(text, caret);
  const line = text.slice(start, end);
  const match = LIST.exec(line);
  if (!match) return null;
  const [marker, indent = "", bullet = "", gap = " ", task] = match;
  if (line.trim() === marker.trim()) return null;
  const numbered = /^(\d+)([.)])$/.exec(bullet);
  const nextBullet = numbered ? `${Number(numbered[1]) + 1}${numbered[2]}` : bullet;
  const inserted = `\n${indent}${nextBullet}${gap}${task ? "[ ] " : ""}`;
  return { text: text.slice(0, caret) + inserted + text.slice(caret), caret: caret + inserted.length };
}

/** Tab nests a list item and Shift+Tab lifts it; other lines keep Tab's usual focus move. */
export function indentListLine(text: string, caret: number, outdent: boolean): { text: string; caret: number } | null {
  const { start, end } = lineBounds(text, caret);
  const line = text.slice(start, end);
  if (!LIST.test(line)) return null;
  if (outdent) {
    const removed = /^ {1,2}/.exec(line)?.[0].length ?? 0;
    if (removed === 0) return null;
    return { text: text.slice(0, start) + line.slice(removed) + text.slice(end), caret: Math.max(start, caret - removed) };
  }
  return { text: `${text.slice(0, start)}  ${line}${text.slice(end)}`, caret: caret + 2 };
}
