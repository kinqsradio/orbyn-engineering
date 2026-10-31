import { afterEach, describe, expect, it, vi } from "vitest";
import { pushUndo, UNDO_MS, undoHasShortcut, undoLatest, useUndoNotice } from "./threadUndo";

afterEach(() => {
  vi.useRealTimers();
  useUndoNotice.setState({ notice: null });
});

describe("thread undo", () => {
  it("groups adjacent actions and undoes them once", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    pushUndo("Settled", first);
    pushUndo("Settled", second);
    expect(useUndoNotice.getState().notice).toEqual({ action: "Settled", count: 2 });
    expect(undoHasShortcut()).toBe(true);
    await undoLatest();
    await undoLatest();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(useUndoNotice.getState().notice).toBeNull();
  });

  it("drops the previous group when the action changes", async () => {
    const settle = vi.fn(() => Promise.resolve());
    const snooze = vi.fn(() => Promise.resolve());
    pushUndo("Settled", settle);
    pushUndo("Snoozed", snooze);
    await undoLatest();
    expect(settle).not.toHaveBeenCalled();
    expect(snooze).toHaveBeenCalledOnce();
  });

  it("expires after five seconds", () => {
    vi.useFakeTimers();
    pushUndo("Archived", () => Promise.resolve());
    vi.advanceTimersByTime(UNDO_MS);
    expect(useUndoNotice.getState().notice).toBeNull();
  });
});
