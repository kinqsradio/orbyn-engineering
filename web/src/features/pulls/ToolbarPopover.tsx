import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { captureFocusReturn, moveFocus, type CloseCause } from "../../ui/focusReturn";
import { closingProps } from "../../ui/Presence";

/** The longest the exit may take: --m-base-out is 140ms, so the fallback never cuts it short. */
const EXIT_FALLBACK_MS = 220;
/** A sheet leaves over --m-slow-out (210ms), so its fallback waits a little longer. */
const SHEET_EXIT_FALLBACK_MS = 320;
/** How far down a drag must go, in px, to dismiss the sheet. */
const DRAG_DISMISS_PX = 80;

/**
 * A panel anchored under the button that opened it, right edges aligned, scaling from that
 * corner. It enters with the --m-base pop and leaves by fading; Escape, a click outside or
 * `dismiss` all end it. From that moment it is inert and hidden from assistive technology and
 * focus is back on the button, so nobody waits for the fade.
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
  const finish = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };
  // The trigger button is where focus returns; `captureFocusReturn` falls back from it if it is gone.
  const [focusReturn] = useState(() => captureFocusReturn(anchor));
  const leaving = useRef(false);
  const leave = (cause: CloseCause, target?: EventTarget | null) => {
    if (leaving.current) return;
    leaving.current = true;
    moveFocus(focusReturn, cause, target);
    setClosing(true);
  };
  const dismiss = () => leave("select");

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(finish, layout === "sheet" ? SHEET_EXIT_FALLBACK_MS : EXIT_FALLBACK_MS);
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
      leave("outside", event.target);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        leave("escape");
      } else if (event.key === "Tab" && !event.shiftKey && role === "menu" && ref.current?.contains(event.target as Node)) {
        event.preventDefault();
        leave("tab");
      }
    };
    // A window blur or a route change closes the popover and leaves focus alone.
    const elsewhere = () => leave("window");
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", elsewhere);
    window.addEventListener("hashchange", elsewhere);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", elsewhere);
      window.removeEventListener("hashchange", elsewhere);
    };
    // `leave` only reads refs and props that cannot change while the panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, role]);

  // Dragging the sheet's top (grab bar and title) down past a threshold dismisses it.
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const dragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (layout !== "sheet" || closing || !target.closest("[data-sheet-handle]") || target.closest("button")) return;
    drag.current = { y: event.clientY, dy: 0 };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const dragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    state.dy = Math.max(0, event.clientY - state.y);
    event.currentTarget.style.transition = "none";
    event.currentTarget.style.translate = `0 ${state.dy}px`;
  };
  const dragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    event.currentTarget.style.transition = "";
    event.currentTarget.style.translate = "";
    if (state.dy > DRAG_DISMISS_PX) leave("escape");
  };

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
        {...closingProps(closing)}
        style={width && layout === "popover" ? { width } : undefined}
        onKeyDown={arrows}
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={dragEnd}
        onTransitionEnd={(event) => {
          // A popover leaves by fading; a sheet by sliding (or fading, under reduced motion).
          if (closing && event.target === event.currentTarget && (layout === "sheet" || event.propertyName === "opacity")) finish();
        }}
      >
        {children(dismiss)}
      </div>
    </>,
    document.body,
  );
}
