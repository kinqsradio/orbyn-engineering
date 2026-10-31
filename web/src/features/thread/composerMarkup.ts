export type MarkupKind = "text" | "marker" | "bold" | "italic" | "strike" | "code" | "link" | "heading" | "quote" | "list" | "fence";

export interface MarkupSpan {
  kind: MarkupKind;
  text: string;
}

const INLINE = /(`+)([^`\n]+?)\1|(\*\*|__)(?=\S)(.+?)\3|(\*|_)(?=\S)([^*_\n]+?)\5|~~(.+?)~~|(\[[^\]\n]*\])(\([^)\n]*\))/g;

function inline(text: string, base: MarkupKind, spans: MarkupSpan[]) {
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > at) spans.push({ kind: base, text: text.slice(at, start) });
    const [whole, ticks, code, stars, bold, star, italic, strike, label, target] = match;
    const wrapped = (mark: string, body: string, kind: MarkupKind) =>
      spans.push({ kind: "marker", text: mark }, { kind, text: body }, { kind: "marker", text: mark });
    if (ticks && code) wrapped(ticks, code, "code");
    else if (stars && bold) wrapped(stars, bold, "bold");
    else if (star && italic) wrapped(star, italic, "italic");
    else if (strike) wrapped("~~", strike, "strike");
    else if (label && target) spans.push({ kind: "link", text: label }, { kind: "marker", text: target });
    else spans.push({ kind: base, text: whole });
    at = start + whole.length;
  }
  if (at < text.length) spans.push({ kind: base, text: text.slice(at) });
}

/**
 * Splits a draft into styled runs that join back into exactly the same text. The
 * markers stay, because what you type is what gets sent.
 */
export function composerMarkup(text: string): MarkupSpan[] {
  const spans: MarkupSpan[] = [];
  let fence: string | null = null;
  const lines = text.split("\n");
  lines.forEach((line, at) => {
    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      spans.push({ kind: "fence", text: line });
      if (opening?.startsWith(fence)) fence = null;
    } else if (opening) {
      fence = opening;
      spans.push({ kind: "fence", text: line });
    } else {
      const block = /^(\s{0,3}#{1,6}\s)(.*)$/.exec(line);
      const quote = /^(\s{0,3}>\s?)(.*)$/.exec(line);
      const list = /^(\s*(?:[-*+]|\d+[.)])\s(?:\[[ xX]\]\s)?)(.*)$/.exec(line);
      if (block) {
        spans.push({ kind: "marker", text: block[1] ?? "" });
        inline(block[2] ?? "", "heading", spans);
      } else if (quote) {
        spans.push({ kind: "marker", text: quote[1] ?? "" });
        inline(quote[2] ?? "", "quote", spans);
      } else if (list) {
        spans.push({ kind: "list", text: list[1] ?? "" });
        inline(list[2] ?? "", "text", spans);
      } else {
        inline(line, "text", spans);
      }
    }
    if (at < lines.length - 1) spans.push({ kind: "text", text: "\n" });
  });
  return spans.filter((span) => span.text !== "");
}
