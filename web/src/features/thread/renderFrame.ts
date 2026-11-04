/** The tool whose result describes a published page. */
export const HTML_RENDER_TOOL = "orbyn_html_render";

/** A published render id: lowercase ULID text, and nothing else. */
const RENDER_ID = /^[0-9a-z]{1,64}$/;
/** The same caps the server applies, so a malformed payload cannot make a 0 px frame. */
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 2000;
const DEFAULT_HEIGHT = 480;
const MAX_TITLE = 200;

/** What the timeline needs to frame one published page. */
export interface RenderFrame {
  title: string;
  /** The page with its frame token, and never the service token. */
  src: string;
  /** The frame's height in CSS pixels. */
  height: number;
}

/**
 * Engines name Orbyn's own tools with their own prefix — Codex says
 * `orbyn_engineering.orbyn_html_render` and Claude `mcp__orbyn_engineering__orbyn_html_render`
 * — so the row is ours when the name ends at a boundary.
 */
export function isHtmlRenderTool(name: string): boolean {
  return (
    name === HTML_RENDER_TOOL ||
    name.endsWith(`.${HTML_RENDER_TOOL}`) ||
    name.endsWith(`__${HTML_RENDER_TOOL}`)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const heightOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(value)))
    : DEFAULT_HEIGHT;

const titleOf = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TITLE) : "HTML";

/**
 * Reads a finished `orbyn_html_render` result into the frame it describes, or null
 * when the text is missing, malformed or not a published render.
 *
 * The `src` is built here from the thread and the render id, because the frame URL
 * must carry `?render=`, a capability for exactly this page. A payload naming a
 * `token=` is refused rather than framed: the service token must never reach a URL
 * that the page's own scripts can read.
 */
export function renderFrameFrom(
  result: string | null | undefined,
  threadId: string | null | undefined,
): RenderFrame | null {
  if (!result || !threadId) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(result);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const { id, frame_token: frameToken, title, height, url } = payload;
  if (typeof id !== "string" || !RENDER_ID.test(id)) return null;
  if (typeof frameToken !== "string" || !frameToken) return null;
  if (url !== undefined && (typeof url !== "string" || url.includes("token="))) return null;
  return {
    title: titleOf(title),
    src: `/api/threads/${encodeURIComponent(threadId)}/renders/${id}?render=${encodeURIComponent(frameToken)}`,
    height: heightOf(height),
  };
}