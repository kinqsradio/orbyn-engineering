export interface TerminalExcerpt {
  id: string;
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export const NO_TERMINAL_CONTEXT: readonly TerminalExcerpt[] = [];
export const MAX_PROMPT_CHARS = 120_000;
export const charactersOver = (text: string): number =>
  text.length <= MAX_PROMPT_CHARS ? 0 : Math.max([...text].length - MAX_PROMPT_CHARS, 0);

export const terminalExcerptLabel = (excerpt: TerminalExcerpt): string =>
  `${excerpt.terminalLabel} ${excerpt.lineStart === excerpt.lineEnd ? `line ${excerpt.lineStart}` : `lines ${excerpt.lineStart}–${excerpt.lineEnd}`}`;

export function terminalSelection(
  text: string,
  position: { start: { y: number }; end: { y: number } } | undefined,
): { text: string; lineStart: number; lineEnd: number } | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!normalized.trim() || !position) return null;
  return { text: normalized, lineStart: position.start.y + 1, lineEnd: Math.max(position.start.y, position.end.y) + 1 };
}

/** Existing plain-text APIs carry the captured output, never a shell command. */
export function terminalContextPrompt(draft: string, excerpts: readonly TerminalExcerpt[]): string {
  return [draft.trim(), ...excerpts.map((excerpt) => {
    // A longer fence keeps even selected Markdown fences inside the excerpt.
    let longest = 2;
    for (const match of excerpt.text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    const fence = "`".repeat(longest + 1);
    const label = terminalExcerptLabel(excerpt).replace(/[\r\n]/g, " ");
    return `Terminal excerpt: ${label}\n${fence}text\n${excerpt.text}\n${fence}`;
  })].filter(Boolean).join("\n\n");
}
