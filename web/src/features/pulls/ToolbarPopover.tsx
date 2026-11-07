import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The longest the exit may take: --m-base-out is 140ms, so the fallback never cuts it short. */
const EXIT_FALLBACK_MS = 220;

/**
 * A panel anchored under the button that opened it, right edges aligned, scaling from that
 * corner. It enters with the --m-base pop and leaves by fading; Escape, a click outside or
 * `dismiss` all end it, and focus returns to the button.
 */
export function ToolbarPopover({
  anchor,
  label,
  role = "dialog",
  layout = "popover",
  width,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  label: string;
  role?: "dialog" | "menu";
  /** A sheet rises from the bottom edge of a phone instead of hanging from the button. */
  layout?: "popover" | "sheet";
  width?: number;
  onClose(): void;
  children: (dismiss: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closed = useRef(false);
  const refocus = useRef(true);
  const finish = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
    if (refocus.current) anchor.focus();
  };
  const dismiss = () => setClosing(true);

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(finish, EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
    // `finish` only reads refs and props that cannot change while the panel is leaving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (layout === "popover") {
      const rect = anchor.getBoundingClientRect();
      const right = Math.max(8, window.innerWidth - rect.right);
      // Measured by layout size so the opening scale can't shrink it.
      const left = window.innerWidth - right - element.offsetWidth;
      element.style.top = `${rect.bottom + 4}px`;
      element.style.right = `${left < 8 ? Math.max(8, window.innerWidth - element.offsetWidth - 8) : right}px`;
      element.style.transformOrigin = "top right";
    }
    element.querySelector<HTMLElement>("button:not(:disabled), input")?.focus();
  }, [anchor, layout]);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (ref.current?.contains(target) || anchor.contains(target))) return;
      refocus.current = false;
      setClosing(true);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setClosing(true);
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor]);

  const arrows = (event: React.KeyboardEvent) => {
    if (role !== "menu" || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  return createPortal(
    <>
      {layout === "sheet" ? <div className="pulls-scrim" data-closing={closing || undefined} /> : null}
      <div
        ref={ref}
        className={layout === "sheet" ? "pulls-pop pulls-sheet" : "pulls-pop"}
        role={role}
        aria-label={label}
        aria-modal={layout === "sheet" ? true : undefined}
        data-closing={closing || undefined}
        style={width && layout === "popover" ? { width } : undefined}
        onKeyDown={arrows}
        onTransitionEnd={(event) => {
          if (closing && event.target === event.currentTarget && event.propertyName === "opacity") finish();
        }}
      >
        {children(dismiss)}
      </div>
    </>,
    document.body,
  );
}
