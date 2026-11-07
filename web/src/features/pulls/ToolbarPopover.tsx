import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { captureFocusReturn, moveFocus, type CloseCause } from "../../ui/focusReturn";
import { closingProps } from "../../ui/Presence";
import { MOTION } from "../../lib/motion";
import { usePrefersReducedMotion } from "../../lib/useLayout";

/** The longest the exit may take: --m-base-out is 140ms, so the fallback never cuts it short. */
const EXIT_FALLBACK_MS = 220;
/** A sheet leaves over --m-slow-out (210ms), so its fallback waits a little longer. */
const SHEET_EXIT_FALLBACK_MS = 320;
/** Under reduced motion the sheet only fades, over --m-fast (150ms). */
const SHEET_REDUCED_FALLBACK_MS = MOTION.fast + 90;
/** A drag dismisses the sheet past this share of its height... */
const DRAG_DISMISS_RATIO = 0.3;
/** ...or when it is moving down faster than this, in px per ms. */
const DRAG_DISMISS_SPEED = 0.5;
const TABBABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';

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
  const reduced = usePrefersReducedMotion();
  const leaving = useRef(false);
  // A sheet owns one history entry, pushed when it opens, so Back closes it and stays on the page.
  const entry = useRef<"none" | "pushed" | "popped">("none");
  const ignorePop = useRef(false);
  const leave = (cause: CloseCause, target?: EventTarget | null) => {
    if (leaving.current) return;
    leaving.current = true;
    moveFocus(focusReturn, cause, target);
    setClosing(true);
    // Closed by anything but Back (and not by leaving the route): take our entry off again, once.
    if (layout === "sheet" && entry.current === "pushed" && cause !== "window") {
      entry.current = "popped";
      ignorePop.current = true;
      window.history.back();
    }
  };
  const dismiss = () => leave("select");

  useEffect(() => {
    if (!closing) return;
    const sheetMs = reduced ? SHEET_REDUCED_FALLBACK_MS : SHEET_EXIT_FALLBACK_MS;
    const timer = setTimeout(finish, layout === "sheet" ? sheetMs : EXIT_FALLBACK_MS);
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
    if (layout !== "sheet") return;
    // Strict mode runs this twice; the entry is pushed once.
    if (entry.current === "none") {
      window.history.pushState({ ...(window.history.state as object | null), orbynSheet: true }, "");
      entry.current = "pushed";
    }
    const back = () => {
      if (ignorePop.current) {
        ignorePop.current = false;
        return;
      }
      // Back (or the edge swipe) already took our entry off.
      entry.current = "popped";
      leave("escape");
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
    // `leave` only reads refs and props that cannot change while the sheet is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // The page behind does not scroll while the sheet is up.
  useEffect(() => {
    if (layout !== "sheet") return;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [layout]);

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
      } else if (event.key === "Tab" && layout === "sheet" && ref.current) {
        // A modal sheet keeps Tab inside: the last control wraps to the first and back.
        const stops = [...ref.current.querySelectorAll<HTMLElement>(TABBABLE)].filter(
          (element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled,
        );
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (!ref.current.contains(active)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
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
  }, [anchor, role, layout]);

  // Dragging the sheet's handle or header down follows the finger; on release it closes past 30% of
  // its height or faster than 0.5px/ms, else springs back. The body never starts a drag, so it scrolls.
  const drag = useRef<{ y: number; dy: number; last: number; at: number; speed: number } | null>(null);
  const dragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (layout !== "sheet" || closing || !target.closest("[data-sheet-handle]") || target.closest("button")) return;
    drag.current = { y: event.clientY, dy: 0, last: event.clientY, at: performance.now(), speed: 0 };
    event.currentTarget.removeAttribute("data-spring");
    event.currentTarget.setAttribute("data-drag", "");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const dragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const now = performance.now();
    if (now > state.at) state.speed = (event.clientY - state.last) / (now - state.at);
    state.last = event.clientY;
    state.at = now;
    state.dy = Math.max(0, event.clientY - state.y);
    event.currentTarget.style.translate = `0 ${state.dy}px`;
  };
  const dragEnd = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    const element = event.currentTarget;
    const height = element.getBoundingClientRect().height;
    element.removeAttribute("data-drag");
    element.style.translate = "";
    if (!cancelled && height > 0 && (state.dy > height * DRAG_DISMISS_RATIO || state.speed > DRAG_DISMISS_SPEED)) {
      // Leaves from where it is, over the share of the exit that is left: no jump.
      const left = Math.min(1, Math.max(0, (height - state.dy) / height));
      element.style.setProperty("--sheet-exit", `calc(var(--m-slow-out) * ${left})`);
      leave("escape");
    } else {
      element.setAttribute("data-spring", "");
    }
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
        onPointerCancel={(event) => dragEnd(event, true)}
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
