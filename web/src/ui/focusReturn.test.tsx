import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Menu } from "./Menu";
import { Presence } from "./Presence";

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => vi.useRealTimers());

const items = [{ label: "Rename" }, { label: "Delete" }];

/** A list of rows; each has a trigger button and opens a menu from it or from a right-click. */
function Rows({ rows = ["a", "b", "c"] }: { rows?: string[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <main>
      <ul>
        {rows.map((row) => (
          <li key={row} tabIndex={0} aria-label={`row ${row}`} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: 5, y: 5 }); }}>
            <span>text {row}</span>
            <button type="button" onClick={() => setMenu({ x: 5, y: 5 })}>
              more {row}
            </button>
          </li>
        ))}
      </ul>
      <button type="button">after</button>
      <p id="plain" onContextMenu={(event) => { event.preventDefault(); setMenu({ x: 5, y: 5 }); }}>
        not focusable
      </p>
      <Presence>{menu ? <Menu {...menu} label="Actions" items={items} onClose={() => setMenu(null)} /> : null}</Presence>
    </main>
  );
}

const open = (name: string) => {
  const trigger = screen.getByRole("button", { name });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
};

it("returns to the trigger button when Escape closes the menu, before the exit fade ends", () => {
  render(<Rows />);
  const trigger = open("more b");
  expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(screen.getByRole("menu", { hidden: true })).toHaveAttribute("inert");
});

it("returns a context menu to the row that was right-clicked", () => {
  render(<Rows />);
  const row = screen.getByRole("listitem", { name: "row b" });
  row.focus();
  fireEvent.contextMenu(screen.getByText("text b"));
  expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  expect(row).toHaveFocus();
});

it("falls back to the neighbour, then the list, then the main region when the saved element is gone", () => {
  const { rerender } = render(<Rows />);
  open("more b");
  rerender(<Rows rows={["a", "c"]} />);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(document.activeElement).not.toBe(document.body);
  expect(screen.getByRole("listitem", { name: "row c" }).contains(document.activeElement) || screen.getByRole("listitem", { name: "row a" }).contains(document.activeElement)).toBe(true);
});

it("falls back to the list, then the main region, when no neighbour is left", () => {
  const { rerender, unmount } = render(<Rows rows={["a"]} />);
  open("more a");
  rerender(<Rows rows={[]} />);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(document.activeElement).toBe(document.querySelector("ul"));
  unmount();

  render(<Rows />);
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.contextMenu(document.getElementById("plain")!);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(document.activeElement).toBe(document.querySelector("main"));
});

it("leaves focus on a focusable target that is clicked outside, and uses the saved element for one that is not", () => {
  render(<Rows />);
  open("more a");
  const after = screen.getByRole("button", { name: "after" });
  fireEvent.mouseDown(after);
  after.focus();
  act(() => void vi.advanceTimersByTime(500));
  expect(after).toHaveFocus();

  const trigger = open("more c");
  fireEvent.mouseDown(document.getElementById("plain")!);
  act(() => void vi.advanceTimersByTime(1));
  expect(trigger).toHaveFocus();
});

it("moves focus to the next element after the trigger on Tab, and does not move it on a window blur", () => {
  render(<Rows />);
  open("more c");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
  expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  act(() => void vi.advanceTimersByTime(500));

  open("more a");
  const item = screen.getByRole("menuitem", { name: "Rename" });
  expect(item).toHaveFocus();
  fireEvent(window, new Event("blur"));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(item).toHaveFocus();
});
