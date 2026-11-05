import { Terminal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../state/ui";
import { terminalExcerptLabel, type TerminalExcerpt } from "./terminalContext";

/** Captured output is plain text. It is never reread from a running terminal. */
export function TerminalContextChips({ threadId, excerpts }: { threadId: string; excerpts: readonly TerminalExcerpt[] }) {
  const [shown, setShown] = useState<string | null>(null);
  const active = excerpts.some((excerpt) => excerpt.id === shown) ? shown : null;
  const root = useRef<HTMLUListElement>(null);
  const preview = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [place, setPlace] = useState({ top: 8, left: 8, width: 420 });
  useLayoutEffect(() => {
    if (!active || !preview.current || !opener.current) return;
    const rect = opener.current.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 16);
    setPlace({
      width,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, rect.top - preview.current.offsetHeight - 8),
    });
  }, [active, threadId]);
  useEffect(() => {
    if (!active) return;
    const close = () => setShown(null);
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !preview.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      opener.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [active, threadId]);
  if (!excerpts.length) return null;
  return <ul ref={root} className="terminal-context-chips" aria-label="Terminal context">
    {excerpts.map((excerpt) => {
      const label = terminalExcerptLabel(excerpt);
      const open = active === excerpt.id;
      return <li key={excerpt.id}>
        <button type="button" className="composer-control" aria-label={`Terminal excerpt, ${label}. Show details`}
          aria-expanded={open} onClick={(event) => { opener.current = event.currentTarget; setShown(open ? null : excerpt.id); }}>
          <Terminal size={14} aria-hidden /> <span>{label}</span>
        </button>
        <button type="button" className="composer-control" aria-label={`Remove terminal excerpt, ${label}`}
          onClick={() => useUi.getState().removeTerminalContexts(threadId, [excerpt.id])}>
          <X size={12} aria-hidden />
        </button>
        {open ? createPortal(<section ref={preview} className="terminal-context-preview" style={place} aria-label={`Terminal excerpt, ${label}`}>
          <strong>{label}</strong>
          <pre tabIndex={0} aria-label="Captured terminal output">{excerpt.text}</pre>
        </section>, document.body) : null}
      </li>;
    })}
  </ul>;
}
