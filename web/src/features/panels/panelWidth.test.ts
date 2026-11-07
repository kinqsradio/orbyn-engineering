import { describe, expect, it } from "vitest";
import { clampPanelWidth, dragPanelWidth, PANEL_DEFAULT, panelMax, snapPoints } from "./panelWidth";

describe("panel width", () => {
  it("opens at 380 and snaps to 380, 520 or 720 within 12 px of a point", () => {
    expect(PANEL_DEFAULT).toBe(380);
    expect(dragPanelWidth(392, 1600)).toBe(380);
    expect(dragPanelWidth(368, 1600)).toBe(380);
    expect(dragPanelWidth(508, 1600)).toBe(520);
    expect(dragPanelWidth(732, 1600)).toBe(720);
    // 13 px away is out of range.
    expect(dragPanelWidth(393, 1600)).toBe(393);
    expect(dragPanelWidth(707, 1600)).toBe(707);
  });

  it("is never narrower than 320 px", () => {
    expect(dragPanelWidth(100, 1600)).toBe(320);
    expect(clampPanelWidth(0, 1600)).toBe(320);
  });

  it("is never wider than 60% of the window, and a snap point past that is not offered", () => {
    expect(panelMax(1000)).toBe(600);
    expect(dragPanelWidth(900, 1000)).toBe(600);
    expect(snapPoints(1000)).toEqual([380, 520]);
    expect(snapPoints(1400)).toEqual([380, 520, 720]);
    // 720 is 14 px past the widest here, so it cannot pull the width over the limit.
    expect(dragPanelWidth(710, 1000)).toBe(600);
  });
});
