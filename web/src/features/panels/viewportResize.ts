/** The page sizes the service takes, and the shapes the device toolbar draws. */

export const PAGE_MIN = 100;
export const PAGE_MAX = 4096;

export interface PageSize {
  width: number;
  height: number;
}

/** A page follows the panel, within the sizes the service takes. */
export function pageSize(width: number, height: number): PageSize {
  const fit = (value: number) => Math.min(PAGE_MAX, Math.max(PAGE_MIN, Math.round(value)));
  return { width: fit(width), height: fit(height) };
}

export const RESIZE_EDGES = ["west", "east", "south", "southwest", "southeast"] as const;
export type ResizeEdge = (typeof RESIZE_EDGES)[number];

/** Every handle the box carries, with the name a screen reader reads out. */
export const RESIZE_HANDLES: readonly { edge: ResizeEdge; name: string }[] = [
  { edge: "west", name: "Resize the page from the left edge" },
  { edge: "east", name: "Resize the page from the right edge" },
  { edge: "south", name: "Resize the page from the bottom edge" },
  { edge: "southwest", name: "Resize the page from the bottom-left corner" },
  { edge: "southeast", name: "Resize the page from the bottom-right corner" },
];

export const RESIZE_KEY_HINT = "Use the arrow keys to resize.";

/** The box a page is drawn in: its own shape, never bigger than the stage. */
export function pageBox(page: PageSize, stage: PageSize): { width: number; height: number; scale: number } {
  // An unmeasured stage says nothing, so the page keeps its own size for that frame.
  const across = stage.width > 0 ? stage.width / page.width : 1;
  const down = stage.height > 0 ? stage.height / page.height : 1;
  const scale = Math.min(1, across, down);
  return { width: Math.round(page.width * scale), height: Math.round(page.height * scale), scale };
}

/** Whether a page still has the shape of a preset, either way round. */
function sameShape(page: PageSize, preset: PageSize): boolean {
  return (
    (preset.width === page.width && preset.height === page.height) ||
    (preset.width === page.height && preset.height === page.width)
  );
}

/**
 * What the device select shows: the chosen preset while the page still has its
 * shape, otherwise `custom`, since a drag or a key press left it behind.
 */
export function deviceChoice(
  chosen: string,
  page: PageSize,
  presets: readonly { id: string; size: PageSize | null }[],
): string {
  if (chosen === "fit") return "fit";
  const preset = presets.find((entry) => entry.id === chosen);
  return preset?.size && sameShape(page, preset.size) ? chosen : "custom";
}

/** The page-pixels one arrow key adds, or null when that handle ignores the key. */
export function resizeKeyStep(edge: ResizeEdge, key: string, shift = false): { x: number; y: number } | null {
  const step = shift ? 50 : 10;
  const across = edge !== "south";
  const down = edge === "south" || edge === "southeast" || edge === "southwest";
  const west = edge === "west" || edge === "southwest";
  if (key === "ArrowLeft" && across) return { x: west ? step : -step, y: 0 };
  if (key === "ArrowRight" && across) return { x: west ? -step : step, y: 0 };
  if (key === "ArrowDown" && down) return { x: 0, y: step };
  if (key === "ArrowUp" && down) return { x: 0, y: -step };
  return null;
}

/** A key press moves the page's own pixels, whatever size it is drawn at. */
export function nudgedPage(page: PageSize, step: { x: number; y: number }): PageSize {
  return pageSize(page.width + step.x, page.height + step.y);
}

/** Where a trailing edge (east, south) lands once the pointer moved `delta`. */
function trailingSize(page: number, delta: number, stage: number, scale: number): number {
  const edge = (stage + page * scale) / 2 + delta;
  return edge <= stage ? 2 * edge - stage : edge;
}

/** Where a leading edge (west) lands once the pointer moved `delta`. */
function leadingSize(page: number, delta: number, stage: number, scale: number): number {
  const edge = (stage - page * scale) / 2 + delta;
  return edge >= 0 ? stage - 2 * edge : stage - edge;
}

/**
 * The page a drag lands on. `start` is the page and `delta` the pointer's
 * movement, both as they were when the drag began; `stage` is the area the box
 * sits in and `scale` the drawn width over the page's width. The box is centred,
 * so a dragged edge moves half as far as its box grows while the box is smaller
 * than the stage, and as far as the pointer once the box fills it.
 */
export function draggedPage(
  start: PageSize,
  delta: { x: number; y: number },
  stage: PageSize,
  scale: number,
  edge: ResizeEdge,
): PageSize {
  const drawn = scale > 0 ? scale : 1;
  const across = edge !== "south";
  const trailing = edge === "east" || edge === "southeast";
  const width =
    across && trailing
      ? trailingSize(start.width, delta.x, stage.width, drawn)
      : across
        ? leadingSize(start.width, delta.x, stage.width, drawn)
        : start.width * drawn;
  // Both bottom corners sit on the same bottom edge, so they follow its rule.
  const down = edge === "south" || edge === "southeast" || edge === "southwest";
  const height = down ? trailingSize(start.height, delta.y, stage.height, drawn) : start.height * drawn;
  return pageSize(width / drawn, height / drawn);
}
