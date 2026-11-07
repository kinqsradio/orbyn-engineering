import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { captureFocusReturn, moveFocus, type CloseCause } from "../../ui/focusReturn";
import { closingProps } from "../../ui/Presence";
import { usePopover } from "../../ui/usePopover";
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
/** Release speed counts only the pointer moves this recent. */
const SPEED_WINDOW_MS = 100;
const TABBABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';

/** Downward px per ms over the pointer moves in the last 100ms before release; 0 if there were none. */
function releaseSpeed(moves: { y: number; at: number }[], now: number): number {
  const from = moves.findIndex((move) => move.at >= now - SPEED_WINDOW_MS);
  const last = moves[moves.length - 1];
  if (from < 0 || !last || moves.length < 2) return 0;
  // The stretch starts at the first sample in the window, or at the one before it when only one is in.
  const start = from === 0 || from < moves.length - 1 ? moves[from]! : moves[from - 1]!;
  return last.at > start.at ? (last.y - start.y) / (last.at - start.at) : 0;
}

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
  closeNow = false,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  label: string;
  role?: "dialog" | "menu";
  /** A sheet rises from the bottom edge of a phone instead of hanging from the button. */
  layout?: "popover" | "sheet";
  width?: number;
  /** Closes it the normal way: the owner needs it gone though nobody chose to close it. */
  closeNow?: boolean;
  onClose(): void;
  children: (dismiss: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closed = useRef(false);
  // A sheet owns one history entry, flagged `history.state.sheet`, pushed when it opens.
  // Back or an in-app navigation takes it off already; any other close pops it once.
  const entry = useRef<"none" | "pushed" | "popped">("none");
  const ignorePop = useRef(false);
  const popEntry = () => {
    if (entry.current !== "pushed") return;
    entry.current = "popped";
    if ((window.history.state as { sheet?: boolean } | null)?.sheet !== true) return;
    ignorePop.current = true;
    window.history.back();
  };
  const finish = () => {
    if (closed.current) return;
    closed.current = true;
    // The pop comes last, after the exit.
    popEntry();
    onClose();
  };
  // The trigger button is where focus returns; `captureFocusReturn` falls back from it if it is gone.
  const [focusReturn] = useState(() => captureFocusReturn(anchor));
  const reduced = usePrefersReducedMotion();
  const mounted = useRef(false);
  const leaving = useRef(false);
  // Inert at once, then (focus has moved already) the exit runs, then the entry pops.
  const exit = () => {
    if (leaving.current) return;
    leaving.current = true;
    ref.current?.setAttribute("inert", "");
    ref.current?.setAttribute("aria-hidden", "true");
    setClosing(true);
  };
  // A popover follows the shared rule: Escape, Tab, Shift+Tab, a real user action outside, a route
  // change. A window blur closes nothing. A menu closes on Tab; the Filters fields are walked.
  const popover = usePopover({
    kind: role === "menu" ? "menu" : "fields",
    root: ref,
    trigger: () => anchor,
    active: layout === "popover",
    closing,
    onClose: exit,
  });
  const leave = (cause: CloseCause, target?: EventTarget | null) => {
    if (layout === "popover") return popover.dismiss(cause, target);
    if (leaving.current) return;
    moveFocus(focusReturn, cause, target);
    exit();
  };
  const dismiss = () => leave("select");

  useEffect(() => {
    if (closeNow) leave("select");
    // `leave` only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeNow]);

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
      window.history.pushState({ ...(window.history.state as object | null), sheet: true }, "");
      entry.current = "pushed";
    }
    mounted.current = true;
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
    return () => {
      window.removeEventListener("popstate", back);
      mounted.current = false;
      // Unmounted without a close (the page left, or the phone layout ended): pop the entry, unless
      // Back or a navigation already took it. Strict mode remounts at once, so look a moment later.
      queueMicrotask(() => {
        if (!mounted.current) popEntry();
      });
    };
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

  // The modal sheet keeps its own close plumbing: a tap on the scrim, Escape, and a Tab trap.
  useEffect(() => {
    if (layout !== "sheet") return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (ref.current?.contains(target) || anchor.contains(target))) return;
      leave("outside", event.target);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        leave("escape");
      } else if (event.key === "Tab" && ref.current) {
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
      }
    };
    // A route change closes the sheet and leaves focus alone; a window blur closes nothing.
    const elsewhere = () => leave("away");
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("hashchange", elsewhere);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("hashchange", elsewhere);
    };
    // `leave` only reads refs and props that cannot change while the sheet is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, layout]);

  // Dragging the sheet's handle or header down follows the finger; on release it closes past 30% of
  // its height or faster than 0.5px/ms, else springs back. The body never starts a drag, so it scrolls.
  const drag = useRef<{ y: number; dy: number; moves: { y: number; at: number }[] } | null>(null);
  const dragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (layout !== "sheet" || closing || !target.closest("[data-sheet-handle]") || target.closest("button")) return;
    drag.current = { y: event.clientY, dy: 0, moves: [{ y: event.clientY, at: performance.now() }] };
    event.currentTarget.removeAttribute("data-spring");
    event.currentTarget.setAttribute("data-drag", "");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const dragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    state.moves.push({ y: event.clientY, at: performance.now() });
    state.dy = Math.max(0, event.clientY - state.y);
    event.currentTarget.style.translate = `0 ${state.dy}px`;
  };
  const dragEnd = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    const element = event.currentTarget;
    const height = element.getBoundingClientRect().height;
    const speed = releaseSpeed(state.moves, performance.now());
    element.removeAttribute("data-drag");
    element.style.translate = "";
    if (!cancelled && height > 0 && (state.dy > height * DRAG_DISMISS_RATIO || speed > DRAG_DISMISS_SPEED)) {
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
