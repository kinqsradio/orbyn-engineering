import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setViewportWidth } from "../test-support";
import { isWide, layoutForWidth, panelOverlays, useLayoutWidth } from "./useLayout";

const modeAt = (width: number) => {
  setViewportWidth(width);
  return renderHook(() => useLayoutWidth()).result.current;
};

describe("layout by window width", () => {
  it("is the phone layout under 600 px", () => {
    expect(modeAt(599)).toBe("phone");
    expect(layoutForWidth(390)).toBe("phone");
  });

  it("is small from 600 to 899 px, the sidebar a drawer and the panel an overlay", () => {
    for (const width of [600, 719, 720, 899]) {
      expect(modeAt(width)).toBe("small");
      expect(layoutForWidth(width)).toBe("small");
    }
    expect(panelOverlays("small")).toBe(true);
  });

  it("is medium from 900 to 1159 px, the sidebar docked and the panel an overlay", () => {
    for (const width of [900, 1000, 1159]) {
      expect(modeAt(width)).toBe("medium");
      expect(layoutForWidth(width)).toBe("medium");
    }
    expect(panelOverlays("medium")).toBe(true);
    expect(isWide("medium")).toBe(false);
  });

  it("is the full layout from 1160 px, everything docked", () => {
    expect(modeAt(1160)).toBe("wide");
    expect(modeAt(1599)).toBe("wide");
    expect(modeAt(1600)).toBe("xwide");
    expect(isWide("wide") && isWide("xwide")).toBe(true);
    expect(panelOverlays("wide")).toBe(false);
  });
});
