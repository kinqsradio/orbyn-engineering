/** The side panel's width rules (Engineer Designs v41 and the designer's answer: the default is 380). */

/** The width a panel opens at, and the one a double click on its edge returns to. */
export const PANEL_DEFAULT = 380;
/** The widths the edge snaps to while it is dragged. */
export const PANEL_SNAPS: readonly number[] = [380, 520, 720];
/** The edge snaps to a point when it is within this many pixels of it. */
export const SNAP_RANGE = 12;
/** The narrowest the panel gets. */
export const PANEL_MIN = 320;
/** The widest the panel gets, as a share of the window. */
export const PANEL_MAX_SHARE = 0.6;

/** The widest the panel gets in a window this wide. Never less than the narrowest. */
export const panelMax = (windowWidth: number) => Math.max(PANEL_MIN, Math.floor(windowWidth * PANEL_MAX_SHARE));

/** The width kept between the narrowest and the widest. */
export const clampPanelWidth = (width: number, windowWidth: number) =>
  Math.max(PANEL_MIN, Math.min(panelMax(windowWidth), Math.round(width)));

/** The snap points this window has room for. */
export const snapPoints = (windowWidth: number) => PANEL_SNAPS.filter((point) => point <= panelMax(windowWidth));

/** What a dragged edge settles on: the nearest snap point within range, else the clamped width. */
export function dragPanelWidth(width: number, windowWidth: number): number {
  const clamped = clampPanelWidth(width, windowWidth);
  const near = snapPoints(windowWidth).find((point) => Math.abs(point - clamped) <= SNAP_RANGE);
  return near ?? clamped;
}
