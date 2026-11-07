import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api, ApiFailure } from "../../api/client";
import type { FsListing } from "../../api/types";
import { BaseDirectoryDialog } from "./BaseDirectoryDialog";

const home: FsListing = { path: "/home", parent: null, entries: [{ name: "Code", path: "/home/Code", is_git: false }] };
const code: FsListing = { path: "/home/Code", parent: "/home", entries: [] };

afterEach(() => vi.restoreAllMocks());

function open(listings: Record<string, FsListing | Error>) {
  vi.spyOn(api, "browse").mockImplementation(async (path) => {
    const found = listings[path ?? ""];
    if (found instanceof Error) throw found;
    return found as FsListing;
  });
  const onChoose = vi.fn();
  const onClose = vi.fn();
  render(<BaseDirectoryDialog onChoose={onChoose} onClose={onClose} />);
  return { onChoose, onClose };
}

it("has a footer, no Close, and Cancel focused", async () => {
  open({ "": home });
  expect(await screen.findByRole("button", { name: "Code" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  expect(screen.queryByRole("button", { name: /^Use Code/ })).toBeNull();
});

it("opens a folder row, goes up one level, and picks the folder shown", async () => {
  const user = userEvent.setup();
  const { onChoose } = open({ "": home, "/home": home, "/home/Code": code });
  await user.click(await screen.findByRole("button", { name: "Code" }));
  expect(await screen.findByText("No folders here.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Up one level" }));
  expect(await screen.findByRole("button", { name: "Code" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Use this folder" }));
  expect(onChoose).toHaveBeenCalledWith("/home");
});

it("jumps to a typed path on Enter", async () => {
  const user = userEvent.setup();
  open({ "": home, "/home": home, "/home/Code": code });
  await screen.findByRole("button", { name: "Code" });
  const field = screen.getByRole("textbox", { name: "Folder path" });
  await user.clear(field);
  await user.type(field, "/home/Code{Enter}");
  expect(await screen.findByText("No folders here.")).toBeVisible();
  expect(field).toHaveValue("/home/Code");
});

it("an unreadable folder offers Try again and cannot be used", async () => {
  const user = userEvent.setup();
  const calls = { n: 0 };
  vi.spyOn(api, "browse").mockImplementation(async () => {
    if (calls.n++ === 0) throw new ApiFailure("io", "denied", 500);
    return home;
  });
  render(<BaseDirectoryDialog onChoose={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByText("Couldn’t read this folder.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Use this folder" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this folder" })).toBeEnabled());
});
