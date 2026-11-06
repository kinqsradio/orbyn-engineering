import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "../../state/ui";
import { applyEvents, emptyLog, type ToolItem } from "./projection";
import type { AgUiEvent, WireThreadEvent } from "../../api/types";
import { McpApp } from "./McpApp";
import { answerApp, readAppMessage, readMcpAppMarker, type AppHost } from "./mcpAppBridge";

const THREAD = "01jc8xw9kq00000000000000aa";
const RENDER = "01jc8xw9kq00000000000000bb";
const FRAME = "c".repeat(64);

/** The marker the service writes, as `crates/orbynd/tests/mcp_apps.rs` reads it back. */
const marker = (over: Record<string, unknown> = {}) => ({
  toolCallId: "app-call-1",
  renderId: RENDER,
  frameToken: FRAME,
  server: "demo",
  tool: "show_widget",
  resourceUri: "ui://demo/widget.html",
  displayMode: "inline",
  prefersBorder: true,
  structuredContent: { text: "hello" },
  ...over,
});

const wire = (seq: number, event: AgUiEvent): WireThreadEvent => ({ seq, thread_id: THREAD, run_id: "r", ts: "", event });

const appRow = (): ToolItem => {
  const log = applyEvents(THREAD, emptyLog, [
    wire(1, { type: "TOOL_CALL_START", toolCallId: "app-call-1", toolCallName: "demo.show_widget" }),
    wire(2, { type: "TOOL_CALL_ARGS", toolCallId: "app-call-1", delta: '{"text":"hello"}' }),
    wire(3, { type: "TOOL_CALL_RESULT", toolCallId: "app-call-1", messageId: "m", content: "shown: hello", role: "tool" }),
    wire(4, { type: "CUSTOM", name: "mcp_app", value: marker() }),
  ]);
  const item = log.items.find((entry) => entry.kind === "tool");
  if (item?.kind !== "tool") throw new Error("Missing tool");
  return item;
};

const host = (over: Partial<AppHost> = {}): AppHost => ({
  theme: "dark",
  displayMode: "inline",
  toolInput: { text: "hello" },
  toolResult: { content: [] },
  resize: vi.fn(),
  ...over,
});

beforeEach(() => useUi.setState({ theme: "dark" }));

describe("MCP App marker", () => {
  it("attaches the page to its tool row", () => {
    expect(appRow().app).toMatchObject({ renderId: RENDER, server: "demo", tool: "show_widget", prefersBorder: true });
  });

  it("refuses a marker the service would not write", () => {
    for (const bad of [
      { renderId: "../x" },
      { frameToken: "token=service" },
      { resourceUri: "https://example.com" },
      { server: "" },
      { toolCallId: 3 },
    ]) {
      expect(readMcpAppMarker(marker(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(readMcpAppMarker(marker({ displayMode: "pip" }))?.displayMode).toBe("inline");
  });
});

describe("MCP App bridge", () => {
  it("initializes with the theme and no extra capabilities", async () => {
    const reply = await answerApp({ id: 1, method: "ui/initialize", params: {} }, host());
    expect(reply).toMatchObject({
      result: { protocolVersion: "2026-01-26", hostCapabilities: {}, hostContext: { theme: "dark", displayMode: "inline" } },
    });
  });

  it("refuses a request it does not serve and ignores unknown notifications", async () => {
    expect(await answerApp({ id: 2, method: "ui/open-link", params: { url: "https://x" } }, host())).toEqual({
      error: { code: -32601, message: "This host does not serve ui/open-link." },
    });
    expect(await answerApp({ method: "notifications/message", params: {} }, host())).toBeNull();
  });

  it("holds a size change to the frame bounds", async () => {
    const resize = vi.fn();
    await answerApp({ method: "ui/notifications/size-changed", params: { height: 99999 } }, host({ resize }));
    await answerApp({ method: "ui/notifications/size-changed", params: { height: 3 } }, host({ resize }));
    await answerApp({ method: "ui/notifications/size-changed", params: { height: "tall" } }, host({ resize }));
    expect(resize.mock.calls).toEqual([[2000], [80]]);
  });

  it("reads only JSON-RPC 2.0 messages", () => {
    expect(readAppMessage({ method: "ping" })).toBeNull();
    expect(readAppMessage({ jsonrpc: "2.0", id: {}, method: "ping" })).toBeNull();
    expect(readAppMessage({ jsonrpc: "2.0", id: 4, method: "ping" })).toEqual({ id: 4, method: "ping", params: {} });
  });
});

describe("MCP App frame", () => {
  it("frames the page with its render token in the sandbox and answers only its own window", async () => {
    render(<McpApp item={appRow()} threadId={THREAD} />);
    const frame = screen.getByTitle("demo show_widget") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBe(`/api/threads/${THREAD}/renders/${RENDER}?render=${FRAME}`);
    const own = frame.contentWindow as Window;
    const sent = vi.spyOn(own, "postMessage");
    const from = (source: Window | null, data: unknown) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data, source }));
        await Promise.resolve();
      });

    await from(window, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    expect(sent).not.toHaveBeenCalled();

    await from(own, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ jsonrpc: "2.0", id: 1, result: expect.anything() }), "*");

    await from(own, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(sent).toHaveBeenCalledWith(
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { text: "hello" } } },
      "*",
    );
    expect(sent).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "shown: hello" }], structuredContent: { text: "hello" } },
      },
      "*",
    );
  });

  it("shows nothing for an ordinary tool row", () => {
    const { container } = render(<McpApp item={{ ...appRow(), app: undefined }} threadId={THREAD} />);
    expect(container.innerHTML).toBe("");
  });
});
