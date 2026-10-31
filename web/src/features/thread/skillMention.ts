export type TriggerChar = "$" | "@" | "/" | "#";

export interface Trigger {
  char: TriggerChar;
  start: number;
  query: string;
}

/** The token being typed at the caret. `/` counts only at the start of the prompt. */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)([$@/#])([\w./-]*)$/.exec(before);
  if (!match) return null;
  const char = match[1] as TriggerChar;
  const query = match[2] ?? "";
  const start = caret - query.length - 1;
  if (char === "/" && start !== 0) return null;
  return { char, start, query };
}

export function insertToken(
  text: string,
  caret: number,
  trigger: Trigger,
  value: string,
  literal?: string,
): { text: string; caret: number } {
  const inserted = `${literal ?? `${trigger.char}${value}`} `;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(caret),
    caret: trigger.start + inserted.length,
  };
}

const label = (text: string) => text.replace(/[[\]]/g, "");

/** A link the timeline renders as a thread, and the agent reads with orbyn_thread_read. */
export const threadToken = (id: string, title: string) => `[${label(title)}](orbyn://thread/${id})`;

export const pullToken = (number: number, title: string, url: string) => `[#${number} ${label(title)}](${url})`;
