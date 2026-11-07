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
