import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../../state/route";
import { PullsToolbar } from "./PullsToolbar";
import { defaultSort, noFilters } from "./pullModel";

function Harness({ phone = true }: { phone?: boolean }) {
  const [filters, setFilters] = useState(noFilters);
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState<string[]>([]);
  return (
    <PullsToolbar
      openCount={4}
      draftCount={1}
      filters={filters}
      onFilters={setFilters}
      sort={defaultSort}
      onSort={() => undefined}
      text={text}
      onText={setText}
      tokens={tokens}
      onTokens={setTokens}
      onSubmit={() => undefined}
      projects={[]}
      allCount={0}
      authors={[]}
      labels={[{ name: "bug", count: 3 }]}
      shown={2}
      phone={phone}
      oneRepo
    />
  );
}

const reduceMotion = () =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

function openSheet() {
  const view = render(<Harness />);
  const filtersButton = screen.getByRole("button", { name: "Filters" });
  fireEvent.click(filtersButton);
  const sheet = screen.getByRole("dialog", { name: "Filters" });
  sheet.getBoundingClientRect = () => ({ height: 400 }) as DOMRect;
  return { sheet, filtersButton, view };
}

const handle = (sheet: HTMLElement) => sheet.querySelector<HTMLElement>("[data-sheet-handle]")!;
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
const gone = () => document.querySelector(".pulls-sheet") === null;
/** A drag from y=0: the pointer goes to `to` after `ms`, then is released. */
function drag(from: HTMLElement, sheet: HTMLElement, to: number, ms: number) {
  fireEvent.pointerDown(from, { pointerId: 1, clientY: 0 });
  wait(ms);
  fireEvent.pointerMove(from, { pointerId: 1, clientY: to });
  fireEvent.pointerUp(from, { pointerId: 1, clientY: to });
  return sheet;
}

describe("phone filter sheet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window.history, "back").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("leaves inert at once and unmounts after the slide", () => {
    const { sheet } = openSheet();
    escape();
    expect(sheet).toHaveAttribute("data-closing");
    expect(sheet).toHaveAttribute("inert");
    expect(document.querySelector(".pulls-scrim")).toHaveAttribute("data-closing");
    wait(319);
    expect(gone()).toBe(false);
    wait(1);
    expect(gone()).toBe(true);
  });

  it("under reduced motion only fades, so it is gone sooner", () => {
    reduceMotion();
    const { sheet } = openSheet();
    escape();
    expect(sheet).toHaveAttribute("data-closing");
    wait(239);
    expect(gone()).toBe(false);
    wait(1);
    expect(gone()).toBe(true);
  });

  it("declares the exit: 210ms --m-io slide, 140ms scrim fade, 150ms fade under reduced motion", () => {
    const css = readFileSync("src/features/pulls/pullsToolbar.css", "utf8");
    expect(css).toMatch(/\.pulls-sheet\[data-closing\] \{[^}]*translate: 0 100%;[^}]*transition: translate var\(--sheet-exit, var\(--m-slow-out\)\) var\(--m-io\);/);
    expect(css).toMatch(/\.pulls-scrim\[data-closing\] \{[^}]*opacity: 0;[^}]*transition: opacity var\(--m-base-out\) var\(--m-io\);/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^]*\.pulls-sheet\[data-closing\] \{[^}]*transition: opacity var\(--m-fast\) var\(--m-io\);/);
    expect(css).toMatch(/\.pulls-sheet\[data-spring\] \{[^}]*transition: translate var\(--m-base\) var\(--m-out\);/);
  });

  it("closes when a drag from the handle passes 30% of its height", () => {
    const { sheet } = openSheet();
    drag(handle(sheet), sheet, 130, 1000);
    expect(sheet).toHaveAttribute("data-closing");
  });

  it("closes on a fast downward flick even below 30%", () => {
    const { sheet } = openSheet();
    drag(handle(sheet), sheet, 40, 20);
    expect(sheet).toHaveAttribute("data-closing");
  });

  it("springs back when the drag is short and slow", () => {
    const { sheet } = openSheet();
    drag(handle(sheet), sheet, 100, 1000);
    expect(sheet).not.toHaveAttribute("data-closing");
    expect(sheet).toHaveAttribute("data-spring");
    expect(sheet.style.translate).toBe("");
  });

  it("follows the finger 1:1 and closes from there over the share of the exit that is left", () => {
    const { sheet } = openSheet();
    fireEvent.pointerDown(handle(sheet), { pointerId: 1, clientY: 0 });
    wait(1000);
    fireEvent.pointerMove(handle(sheet), { pointerId: 1, clientY: 160 });
    expect(sheet.style.translate).toBe("0 160px");
    fireEvent.pointerUp(handle(sheet), { pointerId: 1, clientY: 160 });
    expect(sheet.style.getPropertyValue("--sheet-exit")).toBe("calc(var(--m-slow-out) * 0.6)");
    expect(sheet).toHaveAttribute("data-closing");
  });

  it("starts a drag from the handle and the header, not the body", () => {
    const { sheet } = openSheet();
    const body = sheet.querySelector<HTMLElement>(".pulls-sheet-body")!;
    fireEvent.pointerDown(body, { pointerId: 1, clientY: 0 });
    fireEvent.pointerMove(body, { pointerId: 1, clientY: 300 });
    expect(sheet.style.translate).toBe("");
    fireEvent.pointerUp(body, { pointerId: 1, clientY: 300 });
    expect(sheet).not.toHaveAttribute("data-closing");
    drag(sheet.querySelector<HTMLElement>(".pulls-sheet-head b")!, sheet, 300, 1000);
    expect(sheet).toHaveAttribute("data-closing");
  });

  it("Back closes the sheet, stays on the page and does not pop twice", () => {
    const hash = window.location.hash;
    const { sheet } = openSheet();
    expect(window.history.state).toMatchObject({ sheet: true });
    fireEvent(window, new PopStateEvent("popstate"));
    expect(sheet).toHaveAttribute("data-closing");
    expect(window.history.back).not.toHaveBeenCalled();
    wait(320);
    expect(gone()).toBe(true);
    expect(window.location.hash).toBe(hash);
  });

  it("closes in order: inert, focus back, exit, then the pop", () => {
    const { sheet, filtersButton } = openSheet();
    escape();
    expect(sheet).toHaveAttribute("inert");
    expect(filtersButton).toHaveFocus();
    wait(319);
    expect(window.history.back).not.toHaveBeenCalled();
    wait(1);
    expect(window.history.back).toHaveBeenCalledTimes(1);
    fireEvent(window, new PopStateEvent("popstate"));
    wait(320);
    expect(window.history.back).toHaveBeenCalledTimes(1);
  });

  it("an in-app navigation replaces the sheet's entry and closes it, with no pop", () => {
    const { sheet } = openSheet();
    const length = window.history.length;
    act(() => navigate({ name: "home" }));
    expect(window.history.length).toBe(length);
    expect(window.history.state).toBeNull();
    expect(sheet).toHaveAttribute("data-closing");
    wait(320);
    expect(gone()).toBe(true);
    expect(window.history.back).not.toHaveBeenCalled();
  });

  it("widening past the phone layout closes the sheet normally and pops once, never opening the popover", () => {
    const { sheet, view } = openSheet();
    view.rerender(<Harness phone={false} />);
    expect(sheet).toHaveAttribute("data-closing");
    expect(sheet).toHaveClass("pulls-sheet");
    wait(320);
    expect(gone()).toBe(true);
    expect(document.querySelector(".pulls-pop")).toBeNull();
    expect(window.history.back).toHaveBeenCalledTimes(1);
  });

  it("the page unmounting pops the entry once", async () => {
    const { view } = openSheet();
    view.unmount();
    await Promise.resolve();
    expect(window.history.back).toHaveBeenCalledTimes(1);
  });

  it("does not pop on unmount when Back already took the entry", async () => {
    const { view } = openSheet();
    fireEvent(window, new PopStateEvent("popstate"));
    view.unmount();
    await Promise.resolve();
    expect(window.history.back).not.toHaveBeenCalled();
  });

  it("springs back when the pointer pauses before release, unless it passed 30%", () => {
    const { sheet } = openSheet();
    fireEvent.pointerDown(handle(sheet), { pointerId: 1, clientY: 0 });
    wait(20);
    fireEvent.pointerMove(handle(sheet), { pointerId: 1, clientY: 60 });
    wait(500);
    fireEvent.pointerUp(handle(sheet), { pointerId: 1, clientY: 60 });
    expect(sheet).not.toHaveAttribute("data-closing");
    expect(sheet).toHaveAttribute("data-spring");
    drag(handle(sheet), sheet, 130, 1000);
    expect(sheet).toHaveAttribute("data-closing");
  });

  it("Show N pull requests takes the normal exit and focus returns to Filters", () => {
    const { sheet, filtersButton } = openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "Show 2 pull requests" }));
    expect(sheet).toHaveAttribute("data-closing");
    expect(filtersButton).toHaveFocus();
  });

  it("returns focus to Filters on Escape", () => {
    const { filtersButton } = openSheet();
    escape();
    expect(filtersButton).toHaveFocus();
  });

  it("takes the normal exit when the scrim is tapped, with focus back on Filters", () => {
    const { sheet, filtersButton } = openSheet();
    fireEvent.mouseDown(document.querySelector(".pulls-scrim")!);
    wait(0);
    expect(sheet).toHaveAttribute("data-closing");
    expect(filtersButton).toHaveFocus();
  });

  it("locks page scroll while open and releases it after", () => {
    openSheet();
    expect(document.body.style.overflow).toBe("hidden");
    escape();
    wait(320);
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps Tab inside the modal sheet, wrapping at both ends", () => {
    const { sheet } = openSheet();
    const first = within(sheet).getByRole("button", { name: "Close filters" });
    const last = within(sheet).getByRole("button", { name: "Show 2 pull requests" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });
});
