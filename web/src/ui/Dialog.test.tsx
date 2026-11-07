import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

it("closes a footerless dialog by its Close button or a tap on the backdrop, and a dialog with a footer has no Close", async () => {
  const onClose = vi.fn();
  const { unmount } = render(<Dialog title="Sent files" onClose={onClose}>body</Dialog>);
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  // The backdrop reports the dialog itself as the target; the content does not.
  fireEvent.click(screen.getByText("body"));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("dialog"));
  expect(onClose).toHaveBeenCalledTimes(2);
  unmount();

  const kept = vi.fn();
  render(<Dialog title="Sure?" onClose={kept} footer={<button type="button">Cancel</button>}>body</Dialog>);
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  fireEvent.click(screen.getByRole("dialog"));
  expect(kept).not.toHaveBeenCalled();
});

it("a footerless dialog with a text field ignores a backdrop tap but still closes by Close and Escape", async () => {
  const onClose = vi.fn();
  render(<Dialog title="Switch branch" onClose={onClose}><input aria-label="Branch" /></Dialog>);
  fireEvent.click(screen.getByRole("dialog"));
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("a footerless dialog with only a checkbox still closes on a backdrop tap", () => {
  const onClose = vi.fn();
  render(<Dialog title="Pick" onClose={onClose}><input type="checkbox" aria-label="Yes" /></Dialog>);
  fireEvent.click(screen.getByRole("dialog"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("Escape (the dialog's cancel) closes footerless and footer dialogs alike, but not while a write is in flight", () => {
  const cancel = () => fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  const onClose = vi.fn();
  const { rerender } = render(<Dialog title="Sent files" onClose={onClose}>body</Dialog>);
  cancel();
  rerender(<Dialog title="Sent files" onClose={onClose} footer={<button type="button">Cancel</button>}>body</Dialog>);
  cancel();
  expect(onClose).toHaveBeenCalledTimes(2);
  rerender(<Dialog title="Sent files" onClose={onClose} busy>body</Dialog>);
  cancel();
  expect(onClose).toHaveBeenCalledTimes(2);
});
