/** Splits terminal output into styled spans. Escape sequences never reach the page. */
export interface OutputSpan {
  text: string;
  color: string | null;
  bold: boolean;
}

const BASIC = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
// eslint-disable-next-line no-control-regex
const SEQUENCE = /\u001b(?:\[([0-9;?]*)([A-Za-z])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\^_])/g;

const named = (index: number, bright: boolean) => `var(--ansi-${bright ? "bright-" : ""}${BASIC[index] ?? "white"})`;

export function outputSpans(text: string): OutputSpan[] {
  const spans: OutputSpan[] = [];
  let color: string | null = null;
  let bold = false;
  let last = 0;
  const push = (slice: string) => {
    if (!slice) return;
    const previous = spans.at(-1);
    if (previous && previous.color === color && previous.bold === bold) previous.text += slice;
    else spans.push({ text: slice, color, bold });
  };
  for (const match of text.matchAll(SEQUENCE)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(";").map(Number);
    for (let at = 0; at < codes.length; at += 1) {
      const code = codes[at] ?? 0;
      if (code === 0) {
        color = null;
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = null;
      else if (code >= 30 && code <= 37) color = named(code - 30, false);
      else if (code >= 90 && code <= 97) color = named(code - 90, true);
      else if (code === 38 && codes[at + 1] === 2) {
        color = `rgb(${codes[at + 2] ?? 0} ${codes[at + 3] ?? 0} ${codes[at + 4] ?? 0})`;
        at += 4;
      } else if (code === 38 && codes[at + 1] === 5) at += 2;
    }
  }
  push(text.slice(last));
  return spans;
}
