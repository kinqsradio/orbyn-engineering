import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Menu } from "./Menu";
import { Presence } from "./Presence";
import { usePopover } from "./usePopover";

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
  fireEvent.pointerDown(after);
  after.focus();
  act(() => void vi.advanceTimersByTime(500));
  expect(after).toHaveFocus();

  const trigger = open("more c");
  fireEvent.pointerDown(document.getElementById("plain")!);
  act(() => void vi.advanceTimersByTime(1));
  expect(trigger).toHaveFocus();
});

it("moves focus to the next element after the trigger on Tab, and to the one before it on Shift+Tab", () => {
  render(<Rows />);
  open("more c");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
  expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  act(() => void vi.advanceTimersByTime(500));

  open("more c");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab", shiftKey: true });
  // The row is a tab stop before its own button.
  expect(screen.getByRole("listitem", { name: "row c" })).toHaveFocus();
  expect(screen.getByRole("menu", { hidden: true })).toHaveAttribute("inert");
});

it("does not close on a window blur, and does not close when focus is moved by code", () => {
  render(<Rows />);
  open("more a");
  const item = screen.getByRole("menuitem", { name: "Rename" });
  fireEvent(window, new Event("blur"));
  act(() => screen.getByRole("button", { name: "after" }).focus());
  act(() => void vi.advanceTimersByTime(500));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  expect(item).toBeInTheDocument();
});

it("closes on a key pressed outside, and on a route change, and leaves focus alone", () => {
  render(<Rows />);
  open("more a");
  const after = screen.getByRole("button", { name: "after" });
  act(() => after.focus());
  fireEvent.keyDown(after, { key: "a" });
  expect(after).toHaveFocus();
  act(() => void vi.advanceTimersByTime(500));
  expect(screen.queryByRole("menu")).toBeNull();

  open("more b");
  const item = screen.getByRole("menuitem", { name: "Rename" });
  fireEvent(window, new HashChangeEvent("hashchange"));
  act(() => void vi.advanceTimersByTime(500));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(item.isConnected).toBe(false);
});

const chainItems = [
  { label: "Rename" },
  { label: "Move to…", children: [{ label: "Inbox", onSelect: () => moved() }, { label: "Later" }] },
];
const moved = vi.fn();

function Chain() {
  const [menu, setMenu] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setMenu(true)}>
        more
      </button>
      <Presence>{menu ? <Menu x={5} y={5} label="Actions" items={chainItems} onClose={() => setMenu(false)} /> : null}</Presence>
    </main>
  );
}

const openChild = () => {
  const trigger = screen.getByRole("button", { name: "more" });
  trigger.focus();
  fireEvent.click(trigger);
  const parent = screen.getByRole("menuitem", { name: "Move to…" });
  fireEvent.click(parent);
  return { trigger, parent };
};

it("closes only the child on Escape or ArrowLeft, and focuses the item that opened it", () => {
  render(<Chain />);
  const { parent } = openChild();
  fireEvent.keyDown(screen.getByRole("menu", { name: "Move to…" }), { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Move to…" })).toBeNull();
  expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();
  expect(parent).toHaveFocus();

  fireEvent.click(parent);
  fireEvent.keyDown(screen.getByRole("menu", { name: "Move to…" }), { key: "ArrowLeft" });
  expect(screen.queryByRole("menu", { name: "Move to…" })).toBeNull();
  expect(parent).toHaveFocus();
});

it("closes the whole chain when the child chooses, and focus goes to the root trigger", () => {
  moved.mockClear();
  render(<Chain />);
  const { trigger } = openChild();
  fireEvent.click(screen.getByRole("menuitem", { name: "Inbox" }));
  expect(moved).toHaveBeenCalledTimes(1);
  expect(trigger).toHaveFocus();
  act(() => void vi.advanceTimersByTime(500));
  expect(screen.queryByRole("menu")).toBeNull();
});

/** A non-modal popover with two fields, between two other buttons. */
function Fields({ kind = "fields" as "fields" | "readonly" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  usePopover({ kind, root, active: open, trigger: () => trigger.current, onClose: () => setOpen(false) });
  return (
    <main>
      <button type="button">before</button>
      <button ref={trigger} type="button" onClick={() => setOpen(!open)}>
        trigger
      </button>
      {open ? (
        <div ref={root} role="dialog" aria-label="Fields">
          <input aria-label="first" autoFocus />
          <input aria-label="last" />
        </div>
      ) : null}
      <button type="button">after</button>
    </main>
  );
}

it("walks its fields on Tab, closes after the last to the element after the trigger, with no wrap", () => {
  render(<Fields />);
  fireEvent.click(screen.getByRole("button", { name: "trigger" }));
  const first = screen.getByLabelText("first");
  const last = screen.getByLabelText("last");
  first.focus();
  expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
});

it("goes from the first field to the trigger on Shift+Tab with the popover open, then closes before it", () => {
  render(<Fields />);
  const trigger = screen.getByRole("button", { name: "trigger" });
  fireEvent.click(trigger);
  const first = screen.getByLabelText("first");
  first.focus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(trigger).toHaveFocus();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.keyDown(trigger, { key: "Tab", shiftKey: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "before" })).toHaveFocus();
});

it("enters the popover on Tab from the trigger, and Escape closes it back to the trigger", () => {
  render(<Fields />);
  const trigger = screen.getByRole("button", { name: "trigger" });
  fireEvent.click(trigger);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Tab" });
  expect(screen.getByLabelText("first")).toHaveFocus();
  fireEvent.keyDown(screen.getByLabelText("last"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
});

it("closes a read-only popover on Tab and moves on", () => {
  render(<Fields kind="readonly" />);
  fireEvent.click(screen.getByRole("button", { name: "trigger" }));
  fireEvent.keyDown(screen.getByLabelText("first"), { key: "Tab" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
});
