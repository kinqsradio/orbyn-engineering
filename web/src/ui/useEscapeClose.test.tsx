import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useEscapeClose } from "./useEscapeClose";

function Layer({ onClose }: { onClose(): void }) {
  useEscapeClose(true, onClose, () => null);
  return null;
}

it("closes on Escape while a menu is fading out, but not while one is live", () => {
  const onClose = vi.fn();
  render(<Layer onClose={onClose} />);
  const menu = document.body.appendChild(document.createElement("div"));
  menu.setAttribute("data-menu-root", "");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  menu.setAttribute("data-closing", "");
  menu.setAttribute("inert", "");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  menu.remove();
});
