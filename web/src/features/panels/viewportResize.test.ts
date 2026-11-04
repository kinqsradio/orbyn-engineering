import { describe, expect, it } from "vitest";
import { deviceChoice, draggedPage, nudgedPage, pageBox, pageSize, resizeKeyStep } from "./viewportResize";

const DEVICES = [
  { id: "fit", size: null },
  { id: "phone", size: { width: 393, height: 852 } },
  { id: "laptop", size: { width: 1280, height: 800 } },
];

describe("pageSize", () => {
  it("keeps a page within what the service takes", () => {
    expect(pageSize(640.4, 50)).toEqual({ width: 640, height: 100 });
    expect(pageSize(9000, 480)).toEqual({ width: 4096, height: 480 });
  });
});

describe("pageBox", () => {
  it("keeps the page's shape, centred, and never draws it above its own size", () => {
    expect(pageBox({ width: 393, height: 852 }, { width: 800, height: 600 })).toEqual({
      width: 277,
      height: 600,
      scale: 600 / 852,
    });
    expect(pageBox({ width: 400, height: 300 }, { width: 800, height: 600 })).toEqual({
      width: 400,
      height: 300,
      scale: 1,
    });
  });

  it("draws the page at its own size while the stage has no size yet", () => {
    expect(pageBox({ width: 400, height: 300 }, { width: 0, height: 0 })).toEqual({
      width: 400,
      height: 300,
      scale: 1,
    });
  });
});

describe("draggedPage", () => {
  const stage = { width: 800, height: 2000 };

  it("moves a trailing edge twice as far as the pointer while the box fits", () => {
    const next = draggedPage({ width: 400, height: 300 }, { x: 20, y: 0 }, stage, 1, "east");
    expect(next).toEqual({ width: 440, height: 300 });
  });

  it("moves a leading edge twice as far as the pointer while the box fits", () => {
    const next = draggedPage({ width: 400, height: 300 }, { x: 20, y: 0 }, stage, 1, "west");
    expect(next).toEqual({ width: 360, height: 300 });
  });

  it("moves a bottom edge twice as far as the pointer while the box fits", () => {
    const next = draggedPage({ width: 400, height: 800 }, { x: 0, y: 30 }, stage, 1, "south");
    expect(next).toEqual({ width: 400, height: 860 });
  });

  it("moves one for one once the box fills the stage", () => {
    const next = draggedPage(
      { width: 800, height: 800 },
      { x: 20, y: 0 },
      { width: 800, height: 800 },
      1,
      "east",
    );
    expect(next).toEqual({ width: 820, height: 800 });
  });

  it("counts the pointer in screen pixels, so a scaled page moves further", () => {
    const next = draggedPage({ width: 1600, height: 900 }, { x: 20, y: 0 }, { width: 800, height: 800 }, 0.5, "east");
    expect(next).toEqual({ width: 1640, height: 900 });
  });

  it("changes both axes from a corner", () => {
    const next = draggedPage({ width: 400, height: 300 }, { x: 20, y: 30 }, stage, 1, "southeast");
    expect(next).toEqual({ width: 440, height: 360 });
    const other = draggedPage({ width: 400, height: 300 }, { x: 20, y: 30 }, stage, 1, "southwest");
    expect(other).toEqual({ width: 360, height: 360 });
  });

  it("stops at the sizes the service takes", () => {
    const big = draggedPage({ width: 4000, height: 300 }, { x: 1800, y: 0 }, stage, 1, "east");
    expect(big.width).toBe(4096);
    const small = draggedPage({ width: 200, height: 300 }, { x: 300, y: 0 }, stage, 1, "west");
    expect(small.width).toBe(100);
  });

  it("leaves the page alone when the pointer did not move", () => {
    expect(draggedPage({ width: 400, height: 300 }, { x: 0, y: 0 }, stage, 1, "southeast")).toEqual({
      width: 400,
      height: 300,
    });
  });
});

describe("resizeKeyStep", () => {
  it("steps ten page pixels, fifty with shift", () => {
    expect(resizeKeyStep("east", "ArrowRight")).toEqual({ x: 10, y: 0 });
    expect(resizeKeyStep("east", "ArrowRight", true)).toEqual({ x: 50, y: 0 });
    expect(resizeKeyStep("east", "ArrowLeft")).toEqual({ x: -10, y: 0 });
    expect(resizeKeyStep("west", "ArrowLeft")).toEqual({ x: 10, y: 0 });
    expect(resizeKeyStep("west", "ArrowRight")).toEqual({ x: -10, y: 0 });
    expect(resizeKeyStep("south", "ArrowDown")).toEqual({ x: 0, y: 10 });
    expect(resizeKeyStep("south", "ArrowUp")).toEqual({ x: 0, y: -10 });
    expect(resizeKeyStep("southeast", "ArrowLeft")).toEqual({ x: -10, y: 0 });
    expect(resizeKeyStep("southeast", "ArrowUp", true)).toEqual({ x: 0, y: -50 });
    expect(resizeKeyStep("southwest", "ArrowRight")).toEqual({ x: -10, y: 0 });
    expect(resizeKeyStep("east", "ArrowUp")).toBeNull();
    expect(resizeKeyStep("west", "ArrowDown")).toBeNull();
    expect(resizeKeyStep("south", "ArrowRight")).toBeNull();
  });

  it("grows the page the way the arrow points", () => {
    expect(nudgedPage({ width: 400, height: 300 }, resizeKeyStep("east", "ArrowRight") ?? { x: 0, y: 0 })).toEqual({
      width: 410,
      height: 300,
    });
    expect(nudgedPage({ width: 400, height: 300 }, resizeKeyStep("west", "ArrowRight") ?? { x: 0, y: 0 })).toEqual({
      width: 390,
      height: 300,
    });
  });
});

describe("deviceChoice", () => {
  it("keeps the chosen preset while the page still has its shape", () => {
    expect(deviceChoice("phone", { width: 393, height: 852 }, DEVICES)).toBe("phone");
    expect(deviceChoice("phone", { width: 852, height: 393 }, DEVICES)).toBe("phone");
  });

  it("falls back to custom once a resize left the preset behind", () => {
    expect(deviceChoice("phone", { width: 500, height: 900 }, DEVICES)).toBe("custom");
    expect(deviceChoice("custom", { width: 500, height: 900 }, DEVICES)).toBe("custom");
    expect(deviceChoice("phone", { width: 1280, height: 800 }, DEVICES)).toBe("custom");
  });

  it("keeps fit panel, which follows the stage", () => {
    expect(deviceChoice("fit", { width: 700, height: 500 }, DEVICES)).toBe("fit");
  });
});
