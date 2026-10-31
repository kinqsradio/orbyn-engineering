export type TriggerChar = "$" | "@" | "/";

export interface Trigger {
  char: TriggerChar;
  start: number;
  query: string;
}

/** The token being typed at the caret. `/` counts only at the start of the prompt. */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)([$@/])([\w./-]*)$/.exec(before);
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
): { text: string; caret: number } {
  const inserted = `${trigger.char}${value} `;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(caret),
    caret: trigger.start + inserted.length,
  };
}
