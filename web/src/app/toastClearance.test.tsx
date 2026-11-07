import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useToastClearance } from "./Shell";

let fixture: HTMLElement | undefined;
afterEach(() => {
  fixture?.remove();
  fixture = undefined;
  vi.useRealTimers();
});

it("follows a composer replaced after the initial discovery window", async () => {
  vi.useFakeTimers();
  class TestResizeObserver {
    static instances: TestResizeObserver[] = [];
    observed = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { TestResizeObserver.instances.push(this); }
    observe(element: Element) { this.observed.add(element); }
    unobserve(element: Element) { this.observed.delete(element); }
    disconnect() { this.observed.clear(); }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);

  const composer = document.createElement("div");
  composer.className = "composer";
  composer.getBoundingClientRect = () => ({ top: 600, height: 100 }) as DOMRect;
  fixture = document.createElement("div");
  fixture.append(composer);
  document.body.append(fixture);
  const { unmount } = renderHook(() => useToastClearance("thread:unchanged"));
  const observer = TestResizeObserver.instances[0];
  expect(observer?.observed.has(composer)).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--toast-lift")).toBe(`${window.innerHeight - 600 + 8}px`);

  act(() => { vi.advanceTimersByTime(1100); });
  const replacement = document.createElement("div");
  replacement.className = "composer";
  let top = 500;
  replacement.getBoundingClientRect = () => ({ top, height: 200 }) as DOMRect;
  await act(async () => { composer.remove(); });
  expect(observer?.observed.has(composer)).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--toast-lift")).toBe("0px");
  await act(async () => { fixture?.append(replacement); });
  expect(observer?.observed.has(replacement)).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--toast-lift")).toBe(`${window.innerHeight - 500 + 8}px`);
  top = 450;
  act(() => { observer?.callback([], observer as unknown as ResizeObserver); });
  expect(document.documentElement.style.getPropertyValue("--toast-lift")).toBe(`${window.innerHeight - 450 + 8}px`);

  unmount();
  expect(observer?.observed.size).toBe(0);
  expect(document.documentElement.style.getPropertyValue("--toast-lift")).toBe("");
  act(() => { observer?.callback([], observer as unknown as ResizeObserver); });
  expect(document.documentElement.style.getPropertyValue("--toast-lift")).toBe("");
});
