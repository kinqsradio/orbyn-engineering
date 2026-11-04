import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "../../state/ui";
import { HtmlRender } from "./HtmlRender";
import { isHtmlRenderTool, renderFrameFrom } from "./renderFrame";
import type { ToolItem } from "./projection";

const THREAD = "01jc8xw9kq00000000000000aa";
const RENDER = "01jc8xw9kq00000000000000bb";
const FRAME = "a".repeat(64);

/** Exactly what `POST /api/threads/:id/renders` answers. */
const published = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: RENDER,
    url: `/api/threads/${THREAD}/renders/${RENDER}`,
    frame_token: FRAME,
    title: "Tide chart",
    images: 2,
    bytes: 640,
    height: 520,
    ...over,
  });

const row = (result: string | null, name = "orbyn_html_render"): ToolItem => ({
  key: "tool:c1",
  seq: 1,
  ts: "2026-11-04T00:00:00Z",
  runId: "r1",
  kind: "tool",
  callId: "c1",
  name,
  args: JSON.stringify({ html: "<p>hi</p>" }),
  output: "",
  result,
  done: true,
  exitCode: null,
});

const view = (item: ToolItem) => render(<HtmlRender item={item} threadId={THREAD} />);

beforeEach(() => useUi.setState({ theme: "dark" }));

describe("render frame from a tool result", () => {
  it("reads the published payload into a frame with the render token", () => {
    expect(renderFrameFrom(published(), THREAD)).toEqual({
      title: "Tide chart",
      src: `/api/threads/${THREAD}/renders/${RENDER}?render=${FRAME}`,
      height: 520,
    });
  });

  it("names an untitled page HTML and a missing height the default", () => {
    expect(renderFrameFrom(published({ title: undefined, height: undefined }), THREAD)).toMatchObject({
      title: "HTML",
      height: 480,
    });
    expect(renderFrameFrom(published({ title: "   " }), THREAD)?.title).toBe("HTML");
  });

  it("keeps a height a page could be shown at, and cuts a long title", () => {
    expect(renderFrameFrom(published({ height: 10 }), THREAD)?.height).toBe(120);
    expect(renderFrameFrom(published({ height: 9000 }), THREAD)?.height).toBe(2000);
    expect(renderFrameFrom(published({ height: 300 }), THREAD)?.height).toBe(300);
    expect(renderFrameFrom(published({ title: "t".repeat(400) }), THREAD)?.title).toHaveLength(200);
  });

  it("refuses junk, a missing token and anything naming the service token", () => {
    for (const result of [
      null,
      "",
      "not json",
      "[]",
      "null",
      "42",
      JSON.stringify({ id: RENDER }),
      JSON.stringify({ frame_token: FRAME }),
      JSON.stringify({ id: "../escape", frame_token: FRAME }),
      JSON.stringify({ id: RENDER, frame_token: "" }),
      JSON.stringify({ id: RENDER, frame_token: 7 }),
      published({ url: `/api/threads/${THREAD}/renders/${RENDER}?token=service` }),
      published({ url: 7 }),
    ]) {
      expect(renderFrameFrom(result, THREAD), String(result)).toBeNull();
    }
    // Without a thread there is no route to frame.
    expect(renderFrameFrom(published(), null)).toBeNull();
  });

  it("knows the name each engine reports for Orbyn's own tool", () => {
    expect(isHtmlRenderTool("orbyn_html_render")).toBe(true);
    // Codex and Claude each prefix an MCP server's tools their own way.
    expect(isHtmlRenderTool("orbyn_engineering.orbyn_html_render")).toBe(true);
    expect(isHtmlRenderTool("mcp__orbyn_engineering__orbyn_html_render")).toBe(true);
    expect(isHtmlRenderTool("Read")).toBe(false);
    expect(isHtmlRenderTool("orbyn_html_render_extra")).toBe(false);
    expect(isHtmlRenderTool("xorbyn_html_render")).toBe(false);
  });
});

describe("published page in the timeline", () => {
  it("shows a titled frame with the render token and the page's height", () => {
    const { container } = view(row(published()));
    expect(screen.getByText("Tide chart")).toBeInTheDocument();
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame).toHaveAttribute("src", `/api/threads/${THREAD}/renders/${RENDER}?render=${FRAME}`);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("title", "Tide chart");
    expect(frame).toHaveStyle({ height: "520px", colorScheme: "dark" });
    expect(container.innerHTML).not.toContain("token=");
    expect(container.innerHTML).not.toContain(FRAME + "&");
  });

  it("follows the app's appearance", () => {
    useUi.setState({ theme: "light" });
    const { container } = view(row(published()));
    expect(container.querySelector("iframe")).toHaveStyle({ colorScheme: "light" });
  });

  it("shows nothing for another tool, a running one or a malformed result", () => {
    for (const item of [row(published(), "Bash"), row(null), row("not json"), row("<p>hi</p>")]) {
      const { container, unmount } = view(item);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("opens the page in a dialog and zooms it without growing the card", () => {
    view(row(published()));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Tide chart" });
    const zoom = within(dialog).getByRole("slider", { name: "Zoom" });
    expect(zoom).toHaveValue("100");
    const staged = within(dialog).getByTitle("Tide chart");
    expect(staged).toHaveAttribute("src", `/api/threads/${THREAD}/renders/${RENDER}?render=${FRAME}`);
    expect(staged).toHaveAttribute("sandbox", "allow-scripts");

    fireEvent.change(zoom, { target: { value: "150" } });
    expect(within(dialog).getByText("150%")).toBeInTheDocument();
    // The frame lays out at 1/zoom and is scaled back, so the height above is the
    // height on screen at every zoom.
    expect(staged).toHaveStyle({
      height: `${520 / 1.5}px`,
      transform: "scale(1.5)",
      transformOrigin: "top left",
    });

    fireEvent.change(zoom, { target: { value: "50" } });
    expect(staged).toHaveStyle({ height: "1040px", transform: "scale(0.5)" });
    fireEvent.change(zoom, { target: { value: "200" } });
    expect(staged).toHaveStyle({ height: "260px", transform: "scale(2)" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The card's own frame is still there, unzoomed.
    const card = document.querySelector(".render-card .render-frame");
    expect(card).not.toBeNull();
    expect(card).toHaveStyle({ height: "520px", width: "100%" });
  });
});