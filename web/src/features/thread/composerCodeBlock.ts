/**
 * Fenced code blocks inside the composer: where the caret sits in one, what Tab
 * does, how a block ends, and the language on its opening line. The draft is
 * plain text, so these are functions over the text and the selection, not a
 * rich-text node.
 */

export interface OpenFence {
  /** The info string on the opening line; empty when it names no language. */
  language: string;
  openingStart: number;
  openingEnd: number;
  /** The first character of the block's body. */
  contentStart: number;
}

const FENCE = /^ {0,3}```([^\s`]*)\s*$/;

/** The fence the caret is inside, or null when it is not in a code block. */
export function openFenceAt(text: string, caret: number): OpenFence | null {
  let at = 0;
  let open: OpenFence | null = null;
  while (at <= text.length) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline;
    if (at > caret) break;
    const match = FENCE.exec(text.slice(at, end));
    if (match) {
      open = open
        ? null
        : { language: match[1] ?? "", openingStart: at, openingEnd: end, contentStart: Math.min(end + 1, text.length) };
    }
    if (newline === -1) break;
    at = newline + 1;
  }
  return open;
}

const lineStart = (text: string, caret: number) => text.lastIndexOf("\n", caret - 1) + 1;

const lineEnd = (text: string, caret: number) => {
  const found = text.indexOf("\n", caret);
  return found === -1 ? text.length : found;
};

/**
 * Tab nests a code line two spaces and Shift+Tab lifts it. With a selection,
 * every line it touches moves together. Null means the key keeps its usual job.
 */
export function indentCodeLines(
  text: string,
  start: number,
  end: number,
  outdent: boolean,
): { text: string; start: number; end: number } | null {
  if (!openFenceAt(text, end)) return null;
  const from = lineStart(text, start);
  const to = lineEnd(text, end);
  const block = text.slice(from, to);
  const lines = block.split("\n");
  if (outdent) {
    if (!lines.some((line) => /^ {1,2}\S/.test(line) || /^ {1,2}$/.test(line))) return null;
    const lifted = lines.map((line) => line.replace(/^ {1,2}/, ""));
    const removed = lines.map((line, at) => line.length - (lifted[at]?.length ?? 0));
    const removedFirst = removed[0] ?? 0;
    // The end moves by every line lifted before its own, plus what its line lost before it.
    const lastStart = to - (lines.at(-1)?.length ?? 0);
    const removedBeforeEnd =
      removed.slice(0, -1).reduce((sum, count) => sum + count, 0) + Math.min(removed.at(-1) ?? 0, end - lastStart);
    return {
      text: text.slice(0, from) + lifted.join("\n") + text.slice(to),
      start: Math.max(from, start - removedFirst),
      end: Math.max(from, end - removedBeforeEnd),
    };
  }
  const nested = lines.map((line) => `  ${line}`);
  return {
    text: text.slice(0, from) + nested.join("\n") + text.slice(to),
    start: start + 2,
    end: end + 2 * lines.length,
  };
}

/**
 * Enter on the block's last, empty line closes it and puts the caret after the
 * fence, so typing continues outside the block. Null leaves Enter to its rule.
 */
export function exitCodeBlock(text: string, caret: number): { text: string; caret: number } | null {
  const fence = openFenceAt(text, caret);
  if (!fence) return null;
  const from = lineStart(text, caret);
  const to = lineEnd(text, caret);
  if (caret !== to || text.slice(from, to).trim() !== "") return null;
  const closing = "```";
  const after = text.slice(to);
  const insert = `${closing}${after.startsWith("\n") ? "" : "\n"}`;
  return {
    text: text.slice(0, from) + insert + after,
    caret: from + insert.length,
  };
}

/** Sets or clears the language named on the block's opening line. */
export function setFenceLanguage(text: string, fence: OpenFence, language: string): string {
  const line = text.slice(fence.openingStart, fence.openingEnd);
  const at = line.indexOf("```");
  if (at === -1) return text;
  return `${text.slice(0, fence.openingStart)}${line.slice(0, at + 3)}${language}${text.slice(fence.openingEnd)}`;
}

/** The languages the composer's picker offers; any typed name is also kept. */
export const CODE_LANGUAGES = [
  "",
  "bash",
  "c",
  "cpp",
  "css",
  "diff",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "sh",
  "sql",
  "toml",
  "tsx",
  "typescript",
  "yaml",
] as const;
