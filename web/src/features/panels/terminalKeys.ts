import type { Terminal } from "@xterm/xterm";

type Keys = Pick<Terminal, "scrollPages" | "scrollToTop" | "scrollToBottom" | "selectAll"> & {
  buffer: { active: { type: string } };
};

/**
 * Reading keys that stay out of the shell. True when the key was used. A full-screen
 * program keeps them all, since it draws its own scrollback.
 */
export function readingKey(terminal: Keys, event: KeyboardEvent, mac: boolean): boolean {
  if (event.type !== "keydown" || terminal.buffer.active.type === "alternate") return false;
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "PageUp" || event.key === "PageDown")) {
    terminal.scrollPages(event.key === "PageUp" ? -1 : 1);
    return true;
  }
  if (event.shiftKey && mod && (event.key === "Home" || event.key === "End")) {
    if (event.key === "Home") terminal.scrollToTop();
    else terminal.scrollToBottom();
    return true;
  }
  if (event.key.toLowerCase() === "a" && (mac ? event.metaKey && !event.shiftKey : event.ctrlKey && event.shiftKey)) {
    terminal.selectAll();
    return true;
  }
  return false;
}
