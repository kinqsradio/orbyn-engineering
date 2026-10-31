import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "../../ui/controls";

const HIGHLIGHT = "thread-find";
const CURRENT = "thread-find-current";

interface Highlights {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

const registry = () => (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights;
const makeHighlight = (ranges: Range[]) => new (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(...ranges);

export function rangesIn(root: Node, needle: string): Range[] {
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").toLowerCase();
    for (let at = text.indexOf(lower); at >= 0; at = text.indexOf(lower, at + lower.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + lower.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Find in thread: highlights matches in the transcript and steps through them. */
export function ThreadFind({ onClose }: { onClose(): void }) {
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const ranges = useRef<Range[]>([]);
  const [count, setCount] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const show = useCallback((index: number) => {
    const range = ranges.current[index];
    const css = registry();
    if (!range) return;
    if (css) css.set(CURRENT, makeHighlight([range]));
    range.startContainer.parentElement?.scrollIntoView({ block: "center" });
  }, []);

  useEffect(() => {
    input.current?.focus();
    return () => {
      registry()?.delete(HIGHLIGHT);
      registry()?.delete(CURRENT);
    };
  }, []);

  useEffect(() => {
    const root = document.querySelector(".transcript");
    ranges.current = root ? rangesIn(root, text) : [];
    setCount(ranges.current.length);
    setAt(0);
    const css = registry();
    css?.delete(CURRENT);
    if (css) css.set(HIGHLIGHT, makeHighlight(ranges.current));
    if (ranges.current.length > 0) show(0);
  }, [text, show]);

  const step = (by: number) => {
    if (count === 0) return;
    const next = (at + by + count) % count;
    setAt(next);
    show(next);
  };

  return (
    <div className="thread-find" role="search">
      <input
        ref={input}
        aria-label="Find in thread"
        placeholder="Find in thread"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="thread-find-count" aria-live="polite">
        {text ? (count === 0 ? "0/0" : `${at + 1}/${count}`) : ""}
      </span>
      <IconButton label="Previous match" disabled={count === 0} onClick={() => step(-1)}>
        <ChevronUp size={14} aria-hidden />
      </IconButton>
      <IconButton label="Next match" disabled={count === 0} onClick={() => step(1)}>
        <ChevronDown size={14} aria-hidden />
      </IconButton>
      <IconButton label="Close find" onClick={onClose}>
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  );
}
