import { expect, it } from "vitest";
import { trackInputModality } from "./inputModality";

it("follows the last kind of input, ignoring shortcuts", () => {
  const root = document.createElement("div");
  const stop = trackInputModality(root);
  window.dispatchEvent(new Event("pointerdown"));
  expect(root.dataset.input).toBe("pointer");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  expect(root.dataset.input).toBe("pointer");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  expect(root.dataset.input).toBe("keyboard");
  stop();
  window.dispatchEvent(new Event("pointerdown"));
  expect(root.dataset.input).toBe("keyboard");
});
