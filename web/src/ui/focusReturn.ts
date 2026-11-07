/**
 * Where focus goes when a menu or popover closes, in one place for every one of them.
 *
 * - A trigger-button menu returns to its button. With no trigger (a context menu, a shortcut)
 *   it returns to the element that had focus when it opened; for a context menu that is the
 *   right-clicked element or its nearest focusable ancestor, such as the row.
 * - If that element is gone or hidden: its neighbour, then the list around it, then the main
 *   region. Never `document.body`, and never the menu that is leaving.
 * - By cause: Escape and choosing an item return to that element (an action that opens a dialog
 *   or navigates takes focus itself afterwards). A pointer press outside leaves focus where it
 *   landed, unless the target cannot take focus. Tab moves to the next element after the trigger
 *   and Shift+Tab to the one before it. A key pressed outside, or a route change, closes without
 *   moving focus. A window blur or a programmatic focus change closes nothing: only a real user
 *   action outside does.
 * - A chain (a submenu, or a menu opened from a menu) is one surface: Escape or ArrowLeft in the
 *   child closes the child and focuses the item that opened it; choosing in the child closes the
 *   chain and returns to the root trigger.
 * - Kinds of popover: "menu" and "readonly" close on Tab and Shift+Tab; "fields" lets Tab walk its
 *   fields, closes after the last, and Shift+Tab from the first goes to the trigger (still open).
 *
 * Focus moves when the close starts, before the exit fade, so the callers do it in the event
 * handler that closes. Nothing is announced.
 */

const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
const LIST = '[role="list"], [role="listbox"], [role="tree"], [role="grid"], ul, ol';
const ROW = 'li, [role="listitem"], [role="row"], [role="option"], [role="treeitem"]';
const MAIN = 'main, [role="main"]';

export type CloseCause = "escape" | "select" | "outside" | "tab" | "shiftTab" | "away";

/** How a popover treats Tab: a menu or read-only card closes on it, one with fields walks them. */
export type PopoverKind = "menu" | "fields" | "readonly";

/** Rendered, enabled and not hidden: inside a popover too. */
const visible = (element: Element | null | undefined): element is HTMLElement => {
  if (!element || !element.isConnected || !(element instanceof HTMLElement)) return false;
  if (element.closest("[inert], [hidden]")) return false;
  if ((element as HTMLButtonElement).disabled) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
};

/** Where focus may return to: visible, and not inside a menu or popover that is open or leaving. */
const usable = (element: Element | null | undefined): element is HTMLElement =>
  visible(element) && !element.closest("[data-closing], [data-menu-root], [data-popover-root]");

/** The tab-order elements inside a popover, in page order. */
export const tabbables = (scope: ParentNode): HTMLElement[] =>
  [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.tabIndex >= 0 && visible(element));

const focusable = (element: HTMLElement) => element.matches(FOCUSABLE) && element.tabIndex >= -1;

/** The element itself if it takes focus, else the first descendant that does. */
const focusIn = (element: HTMLElement): HTMLElement | null => {
  if (focusable(element)) return element;
  return [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].find(usable) ?? null;
};

/** A container takes focus programmatically only: tabindex -1 keeps it out of the tab order. */
const focusContainer = (element: HTMLElement | null): boolean => {
  if (!usable(element)) return false;
  if (!element.hasAttribute("tabindex") && !focusable(element)) element.tabIndex = -1;
  element.focus();
  return document.activeElement === element;
};

const tryFocus = (element: HTMLElement | null | undefined): boolean => {
  if (!usable(element)) return false;
  const target = focusIn(element);
  if (!target || !usable(target)) return false;
  target.focus();
  return document.activeElement === target;
};

export interface FocusReturn {
  /** Rule 1: the saved element, else a neighbour, the list, the main region. */
  restore(): void;
  /** Tab: the next tabbable element after the saved one. */
  afterTrigger(): void;
  /** Shift+Tab: the tabbable element before the saved one. */
  beforeTrigger(): void;
  /** The saved element itself, when it can take focus. */
  toTrigger(): boolean;
  /** Pointer press outside: leave focus where the click landed unless that target takes none. */
  afterOutsideClick(target: EventTarget | null): void;
}

/** Remembers the element focus returns to. Call it as the menu opens, before it takes focus. */
export function captureFocusReturn(trigger?: HTMLElement | null): FocusReturn {
  const origin = (() => {
    if (trigger) return trigger;
    // The pointer or key that opened the menu is the best witness of where it was opened from.
    const event = typeof window !== "undefined" ? window.event : undefined;
    const target = event && ["contextmenu", "click"].includes(event.type) ? event.target : null;
    const fromEvent = target instanceof Element ? target.closest<HTMLElement>(FOCUSABLE) : null;
    if (fromEvent && !fromEvent.closest("[data-menu-root]")) return fromEvent;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body && !active.closest("[data-menu-root]") ? active : null;
  })();
  // The neighbours and the list are noted now: once the element is gone they can't be found.
  const row = origin?.closest<HTMLElement>(ROW) ?? origin;
  const neighbours = row ? [row.nextElementSibling, row.previousElementSibling] : [];
  const list = row?.parentElement?.closest<HTMLElement>(LIST) ?? null;

  const restore = () => {
    if (tryFocus(origin)) return;
    for (const neighbour of neighbours) if (tryFocus(neighbour as HTMLElement | null)) return;
    if (focusContainer(list)) return;
    focusContainer(document.querySelector<HTMLElement>(MAIN));
  };

  const afterTrigger = () => {
    if (!usable(origin)) return restore();
    const next = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
      (element) =>
        element.tabIndex >= 0 &&
        usable(element) &&
        !origin.contains(element) &&
        origin.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (next) next.focus();
    else restore();
  };

  const beforeTrigger = () => {
    if (!usable(origin)) return restore();
    const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) =>
        element.tabIndex >= 0 &&
        usable(element) &&
        !origin.contains(element) &&
        origin.compareDocumentPosition(element) & (Node.DOCUMENT_POSITION_PRECEDING | Node.DOCUMENT_POSITION_CONTAINS),
    );
    const previous = all.at(-1);
    if (previous) previous.focus();
    else restore();
  };

  const toTrigger = () => tryFocus(origin);

  const afterOutsideClick = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    // The browser focuses a focusable target after mousedown; leave it to.
    if (element?.closest(FOCUSABLE)) return;
    // The browser drops focus after the mousedown handlers; look once it has.
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active.closest("[data-menu-root], [data-closing]")) restore();
    }, 0);
  };

  return { restore, afterTrigger, beforeTrigger, toTrigger, afterOutsideClick };
}

/** Moves focus for one cause of closing; a key pressed outside or a route change leaves it alone. */
export function moveFocus(focusReturn: FocusReturn, cause: CloseCause, target?: EventTarget | null) {
  if (cause === "escape" || cause === "select") focusReturn.restore();
  else if (cause === "tab") focusReturn.afterTrigger();
  else if (cause === "shiftTab") focusReturn.beforeTrigger();
  else if (cause === "outside") focusReturn.afterOutsideClick(target ?? null);
}

/**
 * Closes on a real user action outside: a pointer press or a key pressed with focus outside, and a
 * route change. A window blur and a programmatic focus change are not user actions and are not
 * heard. Listens in the capture phase so a handler that stops the event can't hide it. Returns the
 * cleanup.
 */
// Known gap, accepted for now: a pointerdown inside the browser panel's webview or an iframe never
// reaches the app, so an open menu stays open. The fix is a host-side signal that reports a webview
// pointerdown as an outside click. Do not approximate it with a window blur: a focus() call from a
// script inside the frame looks the same.
export function watchOutside(inside: (target: EventTarget | null) => boolean, onOutside: (cause: CloseCause, target: EventTarget | null) => void) {
  const pointer = (event: Event) => {
    if (!inside(event.target)) onOutside("outside", event.target);
  };
  const key = (event: Event) => {
    if (!inside(event.target)) onOutside("away", event.target);
  };
  const route = () => onOutside("away", null);
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("hashchange", route);
  return () => {
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("hashchange", route);
  };
}
