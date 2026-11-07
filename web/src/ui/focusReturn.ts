/**
 * Where focus goes when a menu or popover closes, in one place for every one of them.
 *
 * - A trigger-button menu returns to its button. With no trigger (a context menu, a shortcut)
 *   it returns to the element that had focus when it opened; for a context menu that is the
 *   right-clicked element or its nearest focusable ancestor, such as the row.
 * - If that element is gone or hidden: its neighbour, then the list around it, then the main
 *   region. Never `document.body`, and never the menu that is leaving.
 * - By cause: Escape and choosing an item return to that element (an action that opens a dialog
 *   or navigates takes focus itself afterwards). A click outside leaves focus where it landed,
 *   unless the target cannot take focus. Tab moves to the next element after the trigger. A
 *   window blur or a route change closes without moving focus.
 *
 * Focus moves when the close starts, before the exit fade, so the callers do it in the event
 * handler that closes. Nothing is announced.
 */

const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
const LIST = '[role="list"], [role="listbox"], [role="tree"], [role="grid"], ul, ol';
const ROW = 'li, [role="listitem"], [role="row"], [role="option"], [role="treeitem"]';
const MAIN = 'main, [role="main"]';

export type CloseCause = "escape" | "select" | "outside" | "tab" | "window";

const usable = (element: Element | null | undefined): element is HTMLElement => {
  if (!element || !element.isConnected || !(element instanceof HTMLElement)) return false;
  if (element.closest('[inert], [hidden], [data-closing], [data-menu-root]')) return false;
  if ((element as HTMLButtonElement).disabled) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
};

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
  /** Click outside: leave focus where the click landed unless that target takes none. */
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

  return { restore, afterTrigger, afterOutsideClick };
}

/** Moves focus for one cause of closing; a window blur or route change leaves it alone. */
export function moveFocus(focusReturn: FocusReturn, cause: CloseCause, target?: EventTarget | null) {
  if (cause === "escape" || cause === "select") focusReturn.restore();
  else if (cause === "tab") focusReturn.afterTrigger();
  else if (cause === "outside") focusReturn.afterOutsideClick(target ?? null);
}
