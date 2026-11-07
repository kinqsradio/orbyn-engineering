import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "../../state/ui";
import { PaneResizer } from "./SurfacePane";

/** A pane whose right edge is at 1400, in a window 1400 wide, so the pointer's x is 1400 minus the width. */
function setup() {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1400 });
  const view = render(
    <aside data-testid="pane" style={{ width: 520 }}>
      <PaneResizer />
    </aside>,
  );
  const pane = screen.getByTestId("pane");
  pane.getBoundingClientRect = () => ({ right: 1400, width: 520, left: 880, top: 0, bottom: 700, height: 700, x: 880, y: 0, toJSON() {} });
  const handle = screen.getByRole("separator", { name: "Resize panel" });
  handle.setPointerCapture = vi.fn();
  return { view, pane, handle };
}

const drag = (handle: HTMLElement, width: number) => fireEvent.pointerMove(handle, { clientX: 1400 - width, pointerId: 1 });

beforeEach(() => useUi.setState({ panelWidth: null }));

describe("resizing the panel by its edge", () => {
  it("shows the width in a pill and ticks at the snap points while dragging", () => {
    const { handle } = setup();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 880 });
    drag(handle, 600);
    expect(screen.getByRole("status")).toHaveTextContent("600 px");
    expect([...document.querySelectorAll(".pane-tick")].map((tick) => tick.textContent)).toEqual(["380", "520", "720"]);
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.querySelector(".pane-tick")).toBeNull();
  });

  it("snaps to the nearest point within 12 px, and saves the width when the drag ends", () => {
    const { handle, pane } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 880 });
    drag(handle, 731);
    expect(pane.style.width).toBe("720px");
    drag(handle, 392);
    expect(pane.style.width).toBe("380px");
    drag(handle, 420);
    expect(pane.style.width).toBe("420px");
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(useUi.getState().panelWidth).toBe(420);
  });

  it("stops at 320 px and at 60% of the window", () => {
    const { handle, pane } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 880 });
    drag(handle, 200);
    expect(pane.style.width).toBe("320px");
    drag(handle, 1300);
    expect(pane.style.width).toBe("840px");
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(useUi.getState().panelWidth).toBe(840);
  });

  it("returns to 380 px on a double click on the edge", () => {
    useUi.setState({ panelWidth: 700 });
    const { handle } = setup();
    fireEvent.doubleClick(handle);
    expect(useUi.getState().panelWidth).toBe(380);
  });
});
