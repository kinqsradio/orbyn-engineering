import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexHsv, hsvHex, ProviderInstanceColor } from "./ProviderInstanceColor";

// jsdom does not implement the browser top-layer API. This shim makes rendered
// controls queryable; native placement and clipping still require real-browser proof.
const popoverProperties = ["showPopover", "hidePopover"].map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const);
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value(this: HTMLElement) { this.style.display = "block"; } });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value(this: HTMLElement) { this.style.display = "none"; } });
});
afterEach(() => { for (const [key, descriptor] of popoverProperties) {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor); else Reflect.deleteProperty(HTMLElement.prototype, key);
} });
describe("provider accent color", () => {
  it("round trips hex colors through hue, saturation and brightness including grey and hue wrapping", () => {
    for (const color of ["#ff0000", "#00ff00", "#0000ff", "#123456", "#808080", "#000000", "#ffffff"]) expect(hsvHex(hexHsv(color))).toBe(color);
    expect(hsvHex({ h: 420, s: 1, v: 1 })).toBe("#ffff00");
    expect(hsvHex({ h: -120, s: 1, v: 1 })).toBe("#0000ff");
  });
  it("opens full keyboard controls, commits valid hex only and restores focus on Escape", async () => {
    const save = vi.fn(), user = userEvent.setup();
    render(<ProviderInstanceColor name="Work" value="#ff0000" disabled={false} save={save} />);
    const trigger = screen.getByRole("button", { name: "Change accent color for Work" });
    await user.click(trigger);
    const saturation = screen.getByRole("slider", { name: "Accent color saturation" });
    expect(saturation).toHaveFocus();
    fireEvent.keyDown(saturation, { key: "Home" }); expect(save).toHaveBeenLastCalledWith("#ffffff");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Accent color brightness" }), { key: "Home" }); expect(save).toHaveBeenLastCalledWith("#000000");
    const hex = screen.getByRole("textbox", { name: "Custom hex accent color" });
    fireEvent.change(hex, { target: { value: "#abc" } }); const count = save.mock.calls.length;
    fireEvent.change(hex, { target: { value: "#12ABef" } }); expect(save).toHaveBeenLastCalledWith("#12abef"); expect(save).toHaveBeenCalledTimes(count + 1);
    await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
  });
  it("uses the browser top layer and clamps the popup to the viewport", async () => {
    const show = vi.fn(function (this: HTMLElement) { this.style.display = "block"; }), hide = vi.fn();
    const showProperty = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
    const hideProperty = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidePopover");
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: show });
    Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value: hide });
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return (this.classList.contains("provider-accent") ? { left: innerWidth - 10, bottom: innerHeight - 10, top: innerHeight - 30, width: 20, height: 20 } : { width: 224, height: 300 }) as DOMRect;
    });
    try {
      const user = userEvent.setup(); const mounted = render(<ProviderInstanceColor name="Work" value="" disabled={false} save={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "Add accent color for Work" }));
      const popup = screen.getByRole("dialog"); expect(show).toHaveBeenCalledOnce();
      expect(Number.parseFloat(popup.style.left) + 224).toBeLessThanOrEqual(innerWidth - 8);
      expect(Number.parseFloat(popup.style.top) + 300).toBeLessThanOrEqual(innerHeight - 8);
      mounted.unmount(); expect(hide).toHaveBeenCalledOnce();
    } finally {
      bounds.mockRestore();
      if (showProperty) Object.defineProperty(HTMLElement.prototype, "showPopover", showProperty); else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
      if (hideProperty) Object.defineProperty(HTMLElement.prototype, "hidePopover", hideProperty); else Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
    }
  });
  it("owns Escape while a pending save disables and defocuses the popup input", async () => {
    const save = vi.fn(), parent = vi.fn(), user = userEvent.setup();
    const view = render(<div onKeyDown={parent}><ProviderInstanceColor name="Work" value="" disabled={false} save={save} /></div>);
    await user.click(screen.getByRole("button", { name: "Add accent color for Work" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Custom hex accent color" }), { target: { value: "#12abef" } });
    view.rerender(<div onKeyDown={parent}><ProviderInstanceColor name="Work" value="" disabled={true} save={save} /></div>);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(parent).not.toHaveBeenCalled(); expect(save).toHaveBeenCalledOnce();
    view.rerender(<div onKeyDown={parent}><ProviderInstanceColor name="Work" value="#12abef" disabled={false} save={save} /></div>);
    expect(screen.getByRole("button", { name: "Change accent color for Work" })).toHaveFocus();
  });
  it("previews pointer moves and commits once on release or closing an unfinished drag", async () => {
    const save = vi.fn(), user = userEvent.setup();
    render(<ProviderInstanceColor name="Work" value="#ff0000" disabled={false} save={save} />);
    await user.click(screen.getByRole("button", { name: "Change accent color for Work" }));
    const plane = screen.getByRole("group", { name: "Accent color saturation and brightness" });
    vi.spyOn(plane, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    Object.defineProperties(plane, { setPointerCapture: { value: vi.fn() }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: vi.fn() } });
    const pointer = (type: string, x: number, y: number) => fireEvent(plane, Object.assign(new Event(type, { bubbles: true }), { pointerId: 1, button: 0, clientX: x, clientY: y }));
    pointer("pointerdown", 50, 50); pointer("pointermove", 100, 0); expect(save).not.toHaveBeenCalled();
    pointer("pointerup", 100, 0); expect(save).toHaveBeenCalledExactlyOnceWith("#ff0000");
    pointer("pointerdown", 0, 0); expect(save).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(plane, { key: "Escape" });
    expect(save).toHaveBeenCalledTimes(2); expect(save).toHaveBeenLastCalledWith("#ffffff"); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("adds the current preview or clears the stored accent", async () => {
    const save = vi.fn(), user = userEvent.setup();
    const view = render(<ProviderInstanceColor name="Work" value="" disabled={false} save={save} />);
    await user.click(screen.getByRole("button", { name: "Add accent color for Work" })); await user.click(screen.getByRole("button", { name: "Add color" }));
    expect(save).toHaveBeenLastCalledWith("#2563eb");
    view.rerender(<ProviderInstanceColor name="Work" value="#2563eb" disabled={false} save={save} />);
    await user.click(screen.getByRole("button", { name: "Change accent color for Work" })); await user.click(screen.getByRole("button", { name: "Clear color" }));
    expect(save).toHaveBeenLastCalledWith("");
  });
});
