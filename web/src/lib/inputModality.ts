/**
 * Marks the root with how the person last reached a control. Chrome treats a select that
 * a click focused as `:focus-visible`, so its ring stays after a mouse pick; the stylesheet
 * hides that ring while the last input was a pointer, and a key brings it back.
 */
export function trackInputModality(root: HTMLElement = document.documentElement): () => void {
  const pointer = () => root.setAttribute("data-input", "pointer");
  const keyboard = (event: KeyboardEvent) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) root.setAttribute("data-input", "keyboard");
  };
  window.addEventListener("pointerdown", pointer, true);
  window.addEventListener("keydown", keyboard, true);
  return () => {
    window.removeEventListener("pointerdown", pointer, true);
    window.removeEventListener("keydown", keyboard, true);
  };
}
