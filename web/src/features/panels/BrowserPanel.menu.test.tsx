import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readShellStatus } from "../../api/shell";
import type { PreviewTab } from "../../api/types";
import { BrowserPane, BrowserPanel } from "./BrowserPanel";
import { previewWindowRoute, useBrowserPanels } from "./browserPanels";
import { runHandlers } from "../../app/shortcuts";
import { PreviewWindow } from "./PreviewWindow";

class FakeSocket {
  static last: FakeSocket | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { FakeSocket.last = this; }
  close() {}
}

beforeEach(() => {
  FakeSocket.last = null;
  useBrowserPanels.setState({ moved: {} });
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => vi.useRealTimers());

function serve(attached = false) {
  const tabs: PreviewTab[] = ["first", "second"].map((id) => ({
    id, thread_id: "t", url: `https://example.com/${id}`, title: id,
    control: "none", recording: false, viewers: 0, width: 1280, height: 800,
    can_go_back: false, can_go_forward: false, zoom: 1, appearance: "system",
    mobile: false, private: false, profile: null, opened_by: "person", crashed: false,
  }));
  const calls: { method: string; path: string }[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    const body = path === "/api/shell" ? { attached, windows: 1, facts: {} }
      : path === "/api/keybindings" ? { rules: [{ key: "mod+=", command: "preview.zoomIn", when: "previewFocus" }] }
      : path.endsWith("/previews") ? tabs : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { calls, tabs };
}

it("moves the selected live tab between two panels without opening or deleting a browser", async () => {
  const { calls } = serve();
  const user = userEvent.setup();
  render(<BrowserPanel threadId="t" />);
  const panel = screen.getByRole("region", { name: "Browser panel" });
  const tabs = await within(panel).findAllByRole("tab");
  expect(tabs).toHaveLength(2);
  await user.click(tabs[1]!);
  const selected = tabs[1]!.textContent;
  await user.click(within(panel).getByRole("button", { name: "More page actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Move to another panel" }));
  const moved = await screen.findByRole("region", { name: "Second Browser panel" });
  expect(await within(moved).findByRole("tab")).toHaveTextContent(selected!);
  expect(within(panel).getAllByRole("tab")).toHaveLength(1);
  within(moved).getByRole("combobox", { name: "Search or enter URL" }).focus();
  act(() => { runHandlers("preview.zoomIn"); });
  await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toEqual([{ method: "POST", path: "/api/threads/t/previews/second/view" }]));
  await user.click(within(moved).getByRole("button", { name: "More page actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Move to Browser panel" }));
  expect(screen.queryByRole("region", { name: "Second Browser panel" })).toBeNull();
  expect(await within(panel).findAllByRole("tab")).toHaveLength(2);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
});

it("offers popout only with an attached shell and keeps the requested tab in a dedicated viewer", async () => {
  serve();
  await readShellStatus();
  const user = userEvent.setup();
  render(<BrowserPane threadId="t" onlyTabId="first" detached />);
  expect(await screen.findAllByRole("tab")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Pick an element" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "More page actions" }));
  expect(await screen.findByRole("menuitem", { name: "Open in separate window" })).toBeDisabled();
  expect(screen.queryByRole("menuitem", { name: "Float over chat" })).toBeNull();
});

it("sends popout to the existing tab's service boundary when a shell is attached", async () => {
  const { calls } = serve(true);
  await readShellStatus();
  const user = userEvent.setup();
  render(<BrowserPane threadId="t" onlyTabId="second" detached />);
  await user.click(await screen.findByRole("button", { name: "More page actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Open in separate window" }));
  expect(calls).toContainEqual({ method: "POST", path: "/api/threads/t/previews/second/window" });
});

it("cannot create a hidden replacement when a dedicated tab closes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { calls, tabs } = serve();
  render(<BrowserPane threadId="t" onlyTabId="first" detached />);
  await screen.findByRole("tab", { name: "first" });
  const openedAddress = screen.getByRole("combobox", { name: "Search or enter URL" });
  tabs.length = 0;
  // The viewer observes external closure on its next poll, not when the fixture mutates.
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText("This preview tab is closed.")).toBeInTheDocument();
  expect(openedAddress).not.toBeInTheDocument();
  const address = screen.getByRole("combobox", { name: "Search or enter URL" });
  expect(address).toBeDisabled();
  fireEvent.change(address, { target: { value: "https://example.com/replacement" } });
  fireEvent.keyDown(address, { key: "Enter" });
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

it("boxes a portrait page in a wide popout and dispatches its preview keys", async () => {
  const { calls, tabs } = serve(true);
  tabs[0] = { ...tabs[0]!, width: 400, height: 800, control: "human" };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const frame = this.classList.contains("browser-frame");
    return { width: frame ? 300 : 1000, height: 600, left: frame ? 350 : 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  const { container } = render(<PreviewWindow threadId="t" tabId="first" />);
  await waitFor(() => expect(FakeSocket.last?.onmessage).toBeTypeOf("function"));
  act(() => FakeSocket.last?.onmessage?.({ data: "frame" }));
  const frame = await screen.findByRole("img", { name: /^Page at/ });
  expect(container.querySelector(".browser-box")).toHaveStyle({ width: "300px", height: "600px" });
  frame.focus();
  fireEvent.keyDown(frame, { key: "=", code: "Equal", ctrlKey: true });
  await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/api/threads/t/previews/first/view" }));
  expect(calls.some((call) => call.path.endsWith("/input"))).toBe(false);
  expect(calls.some((call) => call.path.endsWith("/resize"))).toBe(false);
});

it("accepts only bounded preview window routes", () => {
  expect(previewWindowRoute("#/preview/thread-1/tab_1")).toEqual({ threadId: "thread-1", tabId: "tab_1" });
  for (const hash of ["#/preview/a/../b", "#/preview/a/b?token=x", "#/preview/a/b/c", "#/preview/a/%2f", `#/preview/a/${"b".repeat(129)}`]) expect(previewWindowRoute(hash)).toBeNull();
});
