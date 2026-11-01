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

/** Addresses in the terminal open on click, wherever links go by the Chat setting. */
export function linkProvider(terminal: Terminal, activate: (url: string) => void): ILinkProvider {
  return {
    provideLinks(row, callback) {
      const text = terminal.buffer.active.getLine(row - 1)?.translateToString(true) ?? "";
      const links = findLinks(text).map<ILink>(({ url, start, end }) => ({
        text: url,
        range: { start: { x: start + 1, y: row }, end: { x: end, y: row } },
        activate: () => activate(url),
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
}
