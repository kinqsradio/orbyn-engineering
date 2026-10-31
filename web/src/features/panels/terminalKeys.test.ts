import { describe, expect, it, vi } from "vitest";
import { readingKey } from "./terminalKeys";

const terminal = (type = "normal") => ({
  scrollPages: vi.fn(),
  scrollToTop: vi.fn(),
  scrollToBottom: vi.fn(),
  selectAll: vi.fn(),
  buffer: { active: { type } },
});
const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("readingKey", () => {
  it("pages, jumps and selects without reaching the shell", () => {
    const term = terminal();
    expect(readingKey(term, key({ key: "PageUp", shiftKey: true }), false)).toBe(true);
    expect(term.scrollPages).toHaveBeenCalledWith(-1);
    expect(readingKey(term, key({ key: "Home", shiftKey: true, ctrlKey: true }), false)).toBe(true);
    expect(term.scrollToTop).toHaveBeenCalled();
    expect(readingKey(term, key({ key: "End", shiftKey: true, metaKey: true }), true)).toBe(true);
    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(readingKey(term, key({ key: "a", metaKey: true }), true)).toBe(true);
    expect(readingKey(term, key({ key: "A", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(term.selectAll).toHaveBeenCalledTimes(2);
  });

  it("leaves everything else, and a full-screen program, alone", () => {
    const term = terminal();
    expect(readingKey(term, key({ key: "a", ctrlKey: true }), false)).toBe(false);
    expect(readingKey(terminal("alternate"), key({ key: "PageUp", shiftKey: true }), false)).toBe(false);
  });
});
