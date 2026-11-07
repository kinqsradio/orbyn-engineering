import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MOTION } from "../lib/motion";
import { Menu } from "./Menu";
import { Presence } from "./Presence";

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => vi.useRealTimers());

function Host({ onSelect = () => {} }: { onSelect?(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)}>
        trigger
      </button>
      <Presence>{open ? <Menu x={10} y={10} label="Actions" items={[{ label: "Rename", onSelect }]} onClose={() => setOpen(false)} /> : null}</Presence>
    </>
  );
}

it("a closing menu is inert and hidden at once, then removed after the exit", () => {
  render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "trigger" }));
  const menu = screen.getByRole("menu", { name: "Actions" });
  expect(menu).not.toHaveAttribute("data-closing");

  fireEvent.click(screen.getByRole("button", { name: "trigger" }));
  // Still in the document for its fade, but nothing can reach it.
  expect(menu).toBeInTheDocument();
  expect(menu).toHaveAttribute("data-closing");
  expect(menu).toHaveAttribute("inert");
  expect(menu).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("menu")).toBeNull();

  act(() => void vi.advanceTimersByTime(MOTION.baseOut - 1));
  expect(menu).toBeInTheDocument();
  act(() => void vi.advanceTimersByTime(1));
  expect(menu).not.toBeInTheDocument();
});

it("opens again during the fade into a fresh, interactive menu", () => {
  render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "trigger" }));
  const old = screen.getByRole("menu");
  fireEvent.click(screen.getByRole("button", { name: "trigger" }));
  fireEvent.click(screen.getByRole("button", { name: "trigger" }));

  const fresh = screen.getByRole("menu", { name: "Actions" });
  expect(fresh).not.toHaveAttribute("inert");
  expect(fresh).not.toBe(old);
  expect(old).not.toBeInTheDocument();
  act(() => void vi.advanceTimersByTime(MOTION.baseOut));
  expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();
});
