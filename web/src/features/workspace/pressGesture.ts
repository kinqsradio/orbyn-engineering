const DRAG_DISTANCE = 6;

export interface PressHandlers {
  onStart(): void;
  onMove(y: number): void;
  /** Where the pointer let go. */
  onEnd(at: { x: number; y: number }): void;
  onCancel(): void;
}

/**
 * Follows a press on the window. It becomes a drag past a few pixels, and the
 * click that ends a drag is swallowed. Escape cancels.
 */
export function trackPress(start: { clientX: number; clientY: number }, handlers: PressHandlers) {
  let active = false;
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
  };
  const swallowClick = () => {
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
  };
  function move(event: PointerEvent) {
    if (!active) {
      const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
      if (moved < DRAG_DISTANCE) return;
      active = true;
      handlers.onStart();
    }
    event.preventDefault();
    handlers.onMove(event.clientY);
  }
  function up(event: PointerEvent) {
    cleanup();
    if (!active) return;
    swallowClick();
    handlers.onEnd({ x: event.clientX, y: event.clientY });
  }
  function cancel() {
    cleanup();
    if (active) handlers.onCancel();
  }
  function key(event: KeyboardEvent) {
    if (event.key !== "Escape" || !active) return;
    event.stopPropagation();
    swallowClick();
    cancel();
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
