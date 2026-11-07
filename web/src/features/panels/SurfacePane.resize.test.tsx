import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUi } from "../../state/ui";
import { PaneResizer } from "./SurfacePane";

beforeEach(() => {
  useUi.setState({ panelWidth: null });
  Object.assign(Element.prototype, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
  Reflect.deleteProperty(Element.prototype, "hasPointerCapture");
  vi.restoreAllMocks();
});

function setup() {
  const view = render(<div data-testid="pane"><PaneResizer /></div>);
  const pane = screen.getByTestId("pane");
  vi.spyOn(pane, "getBoundingClientRect").mockImplementation(() => ({ right: 1200, width: Number.parseFloat(pane.style.width) || 500 }) as DOMRect);
  return { ...view, pane, handle: screen.getByRole("separator", { name: "Resize panel" }) };
}

it("prevents selection and saves the bounded width on pointer up", () => {
  const { pane, handle } = setup();
  const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0 });
  fireEvent(handle, down);
  expect(down.defaultPrevented).toBe(true);
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
  expect(pane.style.width).toBe("780px");
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(useUi.getState().panelWidth).toBe(780);
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1000 });
  expect(pane.style.width).toBe("780px");
});

it("ignores non-primary buttons and other pointers", () => {
  const { pane, handle } = setup();
  fireEvent.pointerDown(handle, { pointerId: 1, button: 2 });
  expect(handle.setPointerCapture).not.toHaveBeenCalled();
  fireEvent.pointerDown(handle, { pointerId: 2, button: 0 });
  fireEvent.pointerDown(handle, { pointerId: 3, button: 0 });
  expect(handle.setPointerCapture).toHaveBeenCalledTimes(1);
  fireEvent.pointerMove(handle, { pointerId: 3, clientX: 1000 });
  expect(pane.style.width).toBe("");
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 1000 });
  expect(pane.style.width).toBe("360px");
});

it.each(["pointerCancel", "lostPointerCapture"] as const)("ends a drag on %s", (eventName) => {
  const { pane, handle } = setup();
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
  fireEvent[eventName](handle, { pointerId: 1 });
  expect(useUi.getState().panelWidth).toBe(600);
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1000 });
  expect(pane.style.width).toBe("600px");
});

it("releases capture when unmounted and preserves double-click reset", () => {
  const { unmount, handle } = setup();
  useUi.setState({ panelWidth: 600 });
  fireEvent.doubleClick(handle);
  expect(useUi.getState().panelWidth).toBeNull();
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
  unmount();
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
});

it.each([false, true])("restores only a drag-owned width when the divider unmounts (parent changed: %s)", (parentChanged) => {
  const { rerender, pane, handle } = setup();
  pane.style.width = "450px";
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
  if (parentChanged) pane.style.width = "";
  rerender(<div data-testid="pane" />);
  expect(pane.style.width).toBe(parentChanged ? "" : "450px");
});

it("does not save a drag into a different thread layout", () => {
  const { pane, handle } = setup();
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
  act(() => useUi.setState({ layoutKey: "another-thread" }));
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(useUi.getState().panelWidth).toBeNull();
  expect(pane.style.width).toBe("");
});

it("restores the destination width if the pointer ends before layout cleanup", () => {
  const { pane, handle } = setup();
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
  act(() => {
    useUi.setState({ layoutKey: "another-thread", panelWidth: 640 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
  });
  expect(useUi.getState().panelWidth).toBe(640);
  expect(pane.style.width).toBe("640px");
});
