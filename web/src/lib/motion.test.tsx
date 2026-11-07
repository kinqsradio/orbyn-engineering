import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Loading } from "../ui/states";
import { MOTION, useWaited } from "./motion";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("reports a wait only after 400 ms, and drops it when the work ends", () => {
  const { result, rerender } = renderHook(({ active }) => useWaited(active), { initialProps: { active: true } });
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(MOTION.wait - 1));
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toBe(true);
  rerender({ active: false });
  expect(result.current).toBe(false);
});

it("never reports a wait for work that ends inside it, and clears its timer on unmount", () => {
  const { result, rerender, unmount } = renderHook(({ active }) => useWaited(active), { initialProps: { active: true } });
  act(() => vi.advanceTimersByTime(MOTION.wait - 100));
  rerender({ active: false });
  act(() => vi.advanceTimersByTime(MOTION.wait));
  expect(result.current).toBe(false);
  rerender({ active: true });
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("draws the static skeleton only after the wait, with the label read at once", () => {
  const { container } = render(<Loading label="Loading usage" rows={3} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading usage");
  expect(container.querySelectorAll(".skeleton")).toHaveLength(0);
  act(() => vi.advanceTimersByTime(MOTION.wait));
  expect(container.querySelectorAll(".skeleton")).toHaveLength(3);
});
