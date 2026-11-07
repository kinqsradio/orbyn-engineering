import { useEffect, useRef } from "react";
import { captureFocusReturn, moveFocus } from "./focusReturn";

/**
 * Escape closes a layer that floats over the page but does not take it over, such as the side
 * panel overlay or the sidebar drawer. Focus returns to its button by the shared rule in
 * `focusReturn.ts`. Anything on top of it gets Escape first: a menu, a popover or a dialog that
 * handles the key marks it as handled, and a modal dialog being open is enough to leave it alone.
 */
export function useEscapeClose(active: boolean, onClose: () => void, trigger: () => HTMLElement | null) {
  const latest = useRef({ onClose, trigger });
  latest.current = { onClose, trigger };
  useEffect(() => {
    if (!active) return;
    const focusReturn = captureFocusReturn(latest.current.trigger());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // A menu in its exit fade is already closed: it is inert and marked closing.
      const live = ":not([data-closing]):not([inert])";
      if (document.querySelector(`dialog[open], [aria-modal='true'], [data-menu-root]${live}, [data-popover-root]${live}`)) return;
      event.preventDefault();
      moveFocus(focusReturn, "escape");
      latest.current.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);
}
