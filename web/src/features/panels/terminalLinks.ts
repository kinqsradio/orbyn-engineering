import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

const ADDRESS = /https?:\/\/[^\s<>"'`]+/g;
/** Sentence punctuation after an address belongs to the sentence. */
const TRAILING = /[.,;:!?)\]}]+$/;

export interface FoundLink {
  url: string;
  /** Zero-based, inclusive of `start` and exclusive of `end`. */
  start: number;
  end: number;
}

export function findLinks(line: string): FoundLink[] {
  return [...line.matchAll(ADDRESS)].flatMap((match) => {
    const url = match[0].replace(TRAILING, "");
    return URL.canParse(url) ? [{ url, start: match.index, end: match.index + url.length }] : [];
  });
}

export interface FoundFileLink {
  path: string;
  line: number | null;
  column: number | null;
  /** Zero-based, inclusive of `start` and exclusive of `end`. */
  start: number;
  end: number;
}

export type TerminalLink =
  | ({ kind: "url" } & FoundLink)
  | ({ kind: "file" } & FoundFileLink);

/** One token of the line, before the punctuation around it is trimmed. */
const CANDIDATE = /[^\s<>"'`|]+/g;
const LEADING = /^[([{]+/;
/** Punctuation around a path belongs to the sentence. */
const AROUND = /[.,;:!?)\]}]+$/;
/** `:line` or `:line:col`, with the first colon followed by digits. */
const SUFFIX = /^(.*?):(\d+)(?::(\d+))?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** A bare host and port is an address, not a file. */
const HOST_PORT = /^[A-Za-z0-9.-]+:\d+(?:[\\/]|$)/;

function parsePath(text: string): Omit<FoundFileLink, "start" | "end"> | null {
  if (!text || SCHEME.test(text)) return null;
  const suffix = text.match(SUFFIX);
  const path = suffix ? suffix[1] : text;
  if (!path || !/[\\/]/.test(path) || HOST_PORT.test(path) || /[\\/]$/.test(path)) return null;
  return {
    path,
    line: suffix ? Number(suffix[2]) : null,
    column: suffix && suffix[3] ? Number(suffix[3]) : null,
  };
}

/** Workspace files named in a line. Paths need a separator, so bare words stay text. */
export function findFileLinks(line: string): FoundFileLink[] {
  const urls = findLinks(line);
  return [...line.matchAll(CANDIDATE)].flatMap((match) => {
    const token = match[0];
    const at = match.index ?? 0;
    const lead = token.match(LEADING);
    const offset = lead ? lead[0].length : 0;
    const trimmed = token.slice(offset).replace(AROUND, "");
    if (!trimmed) return [];
    const start = at + offset;
    const end = start + trimmed.length;
    if (urls.some((url) => start < url.end && end > url.start)) return [];
    const parsed = parsePath(trimmed);
    return parsed ? [{ ...parsed, start, end }] : [];
  });
}

/** Addresses and files in a line, left to right. */
export function findTerminalLinks(line: string): TerminalLink[] {
  const urls = findLinks(line).map<TerminalLink>((url) => ({ kind: "url", ...url }));
  const files = findFileLinks(line).map<TerminalLink>((file) => ({ kind: "file", ...file }));
  return [...urls, ...files].sort((a, b) => a.start - b.start);
}

function label(link: TerminalLink): string {
  if (link.kind === "url") return link.url;
  const suffix = link.line === null ? "" : `:${link.line}${link.column === null ? "" : `:${link.column}`}`;
  return `${link.path}${suffix}`;
}

/** Addresses and files in the terminal open on click. */
export function linkProvider(terminal: Terminal, activate: (link: TerminalLink) => void): ILinkProvider {
  return {
    provideLinks(row, callback) {
      const text = terminal.buffer.active.getLine(row - 1)?.translateToString(true) ?? "";
      const links = findTerminalLinks(text).map<ILink>((link) => ({
        text: label(link),
        range: { start: { x: link.start + 1, y: row }, end: { x: link.end, y: row } },
        activate: () => activate(link),
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
}
