import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
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
  it("offers only what the host was given", async () => {
    const full = await answerApp(
      { id: 1, method: "ui/initialize", params: {} },
      host({ callTool: vi.fn(), sendMessage: vi.fn(), requestDisplayMode: vi.fn() }),
    );
    expect(full).toMatchObject({
      result: {
        hostCapabilities: { serverTools: {}, message: { text: {} } },
        hostContext: { availableDisplayModes: ["inline", "fullscreen"] },
      },
    });
  });

  it("passes a tool call on and reports its failure as the page's error", async () => {
    const callTool = vi.fn().mockResolvedValueOnce({ content: [] }).mockRejectedValueOnce(new Error("The person declined."));
    const call = { id: 3, method: "tools/call", params: { name: "pick", arguments: { a: 1 } } };
    expect(await answerApp(call, host({ callTool }))).toEqual({ result: { content: [] } });
    expect(callTool).toHaveBeenCalledWith("pick", { a: 1 });
    expect(await answerApp(call, host({ callTool }))).toEqual({ error: { code: -32000, message: "The person declined." } });
    expect(await answerApp({ id: 4, method: "tools/call", params: { name: "", arguments: {} } }, host({ callTool }))).toMatchObject({
      error: { code: -32602 },
    });
    expect(await answerApp({ id: 5, method: "tools/call", params: { name: "pick", arguments: [1] } }, host({ callTool }))).toMatchObject({
      error: { code: -32602 },
    });
    expect(await answerApp(call, host())).toMatchObject({ error: { code: -32601 } });
  });

  it("sends only user text as a message", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const send = (params: Record<string, unknown>) => answerApp({ id: 6, method: "ui/message", params }, host({ sendMessage }));
    expect(await send({ role: "user", content: [{ type: "text", text: " pick blue " }] })).toEqual({ result: {} });
    expect(await send({ role: "user", content: { type: "text", text: "one block" } })).toEqual({ result: {} });
    expect(sendMessage.mock.calls).toEqual([["pick blue"], ["one block"]]);
    for (const bad of [
      { role: "assistant", content: [{ type: "text", text: "x" }] },
      { role: "user", content: [{ type: "image", data: "x" }] },
      { role: "user", content: [{ type: "text", text: "  " }] },
    ]) {
      expect(await send(bad), JSON.stringify(bad)).toMatchObject({ error: { code: -32602 } });
    }
  });

  it("keeps a note from text and structured content and refuses other blocks", async () => {
    const updateContext = vi.fn().mockResolvedValue(undefined);
    const note = (params: Record<string, unknown>) => answerApp({ id: 8, method: "ui/update-model-context", params }, host({ updateContext }));
    expect(await note({ content: [{ type: "text", text: "picked blue" }], structuredContent: { color: "blue" } })).toEqual({ result: {} });
    expect(await note({})).toEqual({ result: {} });
    expect(updateContext.mock.calls).toEqual([['picked blue\n{"color":"blue"}'], [""]]);
    expect(await note({ content: [{ type: "image", data: "x" }] })).toMatchObject({ error: { code: -32602 } });
  });

  it("switches display mode only between the two it knows", async () => {
    const requestDisplayMode = vi.fn((mode: string) => mode as "inline" | "fullscreen");
    const ask = (mode: unknown) => answerApp({ id: 7, method: "ui/request-display-mode", params: { mode } }, host({ requestDisplayMode }));
    expect(await ask("fullscreen")).toEqual({ result: { mode: "fullscreen" } });
    expect(await ask("pip")).toEqual({ result: { mode: "inline" } });
    expect(requestDisplayMode.mock.calls).toEqual([["fullscreen"]]);
  });

  it("initializes with the theme and no extra capabilities", async () => {
    const reply = await answerApp({ id: 1, method: "ui/initialize", params: {} }, host());
    expect(reply).toMatchObject({
      result: {
        protocolVersion: "2026-01-26",
        hostCapabilities: {},
        hostContext: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"] },
      },
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

  it("runs an app's tool call only after the person confirms it in the host", async () => {
    const call = vi.spyOn(api, "mcpAppToolCall").mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    render(<McpApp item={appRow()} threadId={THREAD} />);
    const own = (screen.getByTitle("demo show_widget") as HTMLIFrameElement).contentWindow as Window;
    const sent = vi.spyOn(own, "postMessage");
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "pick", arguments: { color: "blue" } } },
          source: own,
        }),
      );
      await Promise.resolve();
    });
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText("demo wants to run pick")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run tool" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(call).toHaveBeenCalledWith(THREAD, RENDER, "pick", { color: "blue" });
    expect(sent).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "ok" }] } }, "*");
  });

  it("answers a declined message with an error and sends nothing", async () => {
    const message = vi.spyOn(api, "mcpAppMessage").mockResolvedValue({} as never);
    render(<McpApp item={appRow()} threadId={THREAD} />);
    const own = (screen.getByTitle("demo show_widget") as HTMLIFrameElement).contentWindow as Window;
    const sent = vi.spyOn(own, "postMessage");
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { jsonrpc: "2.0", id: 10, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "pick blue" }] } },
          source: own,
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    expect(message).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 10, error: { code: -32000, message: "The person declined." } }, "*");
  });

  it("shows the same frame full screen and back", () => {
    const { container } = render(<McpApp item={appRow()} threadId={THREAD} />);
    const frame = screen.getByTitle("demo show_widget");
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(container.querySelector("figure")?.getAttribute("data-display")).toBe("fullscreen");
    expect(screen.getByTitle("demo show_widget")).toBe(frame);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector("figure")?.getAttribute("data-display")).toBe("inline");
  });

  it("shows a sent note in the timeline", () => {
    const log = applyEvents(THREAD, emptyLog, [wire(1, { type: "CUSTOM", name: "mcp_app.context", value: { server: "demo", text: "x" } })]);
    expect(log.items[0]).toMatchObject({ kind: "notice", text: "Sent demo's app note with this message" });
  });

  it("says when the next message carries the page's note and can drop it", async () => {
    const put = vi.spyOn(api, "mcpAppContext").mockResolvedValue(undefined);
    const clear = vi.spyOn(api, "clearMcpAppContext").mockResolvedValue(undefined);
    render(<McpApp item={appRow()} threadId={THREAD} />);
    const own = (screen.getByTitle("demo show_widget") as HTMLIFrameElement).contentWindow as Window;
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { jsonrpc: "2.0", id: 11, method: "ui/update-model-context", params: { content: [{ type: "text", text: "blue" }] } },
          source: own,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(put).toHaveBeenCalledWith(THREAD, RENDER, "blue");
    expect(screen.getByText("Your next message carries a note from demo.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      await Promise.resolve();
    });
    expect(clear).toHaveBeenCalledWith(THREAD);
    expect(screen.queryByText("Your next message carries a note from demo.")).toBeNull();
  });

  it("shows nothing for an ordinary tool row", () => {
    const { container } = render(<McpApp item={{ ...appRow(), app: undefined }} threadId={THREAD} />);
    expect(container.innerHTML).toBe("");
  });
});
