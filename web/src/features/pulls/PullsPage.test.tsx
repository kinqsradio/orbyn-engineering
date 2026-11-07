import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pullsApi } from "../../api/pulls";
import type { PullList } from "../../api/types";
import { MOTION } from "../../lib/motion";
import { setViewportWidth } from "../../test-support";
import { PullsPage } from "./PullsPage";

let finish!: (list: PullList) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(pullsApi, "list").mockReturnValue(new Promise<PullList>((resolve) => { finish = resolve; }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const skeletonRows = () => document.querySelectorAll(".pull-skel > li");

it("says Loading in the header, with the table header already there", () => {
  render(<PullsPage />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  expect(screen.getByText("Pull request")).toBeInTheDocument();
});

it("shows nothing under the header before 400 ms and 6 skeleton rows after", () => {
  render(<PullsPage />);
  act(() => void vi.advanceTimersByTime(MOTION.wait - 1));
  expect(skeletonRows()).toHaveLength(0);
  act(() => void vi.advanceTimersByTime(1));
  expect(skeletonRows()).toHaveLength(6);
});

it("removes the skeleton when the data arrives", async () => {
  render(<PullsPage />);
  act(() => void vi.advanceTimersByTime(MOTION.wait));
  expect(skeletonRows()).toHaveLength(6);
  await act(async () => finish({ pulls: [], failed: [] }));
  expect(skeletonRows()).toHaveLength(0);
});

it("keeps the desktop Filters popover at 700 px; only a phone gets the sheet", () => {
  setViewportWidth(700);
  render(<PullsPage />);
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();
  expect(document.querySelector(".pulls-sheet")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Search people" })).toBeInTheDocument();
});
