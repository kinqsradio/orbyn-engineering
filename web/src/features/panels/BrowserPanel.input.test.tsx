import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PreviewTab } from "../../api/types";
import { PageView } from "./BrowserPanel";

class FakeSocket {
  static last: FakeSocket | null = null;
  static all: FakeSocket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.all.push(this);
  }
  close() {}
}

/** Keeps the stage's observer so the test can say when the panel changed size. */
class Observer {
  static all: Observer[] = [];
  constructor(readonly callback: ResizeObserverCallback) {
    Observer.all.push(this);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

const tab: PreviewTab = {
  id: "tab-1",
  thread_id: "t",
  url: "http://localhost:3000/",
  control: "human",
  recording: false,
  viewers: 1,
  width: 1280,
  height: 800,
  can_go_back: false,
  can_go_forward: false,
  title: "Local",
  zoom: 1,
  appearance: "system",
  mobile: false,
  private: false,
  profile: null,
  opened_by: "person",
  crashed: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeSocket.last = null;
  FakeSocket.all = [];
  Observer.all = [];
});

it("maps a click to the size the page was just fitted to, before the tab list catches up", async () => {
  const bodies: { path: string; body: Record<string, number | string> }[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push({ path: input, body: JSON.parse(init.body) as Record<string, number | string> });
    // The resize answers, but the tab passed in keeps its old size, as it does until the next poll.
    return new Response(input.endsWith("/resize") ? JSON.stringify(tab) : null, { status: input.endsWith("/resize") ? 200 : 204 });
  });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", Observer);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  render(<PageView threadId="t" tab={tab} />);
  await waitFor(() => expect(FakeSocket.last?.onmessage).toBeTypeOf("function"));
  act(() => FakeSocket.last?.onmessage?.({ data: "frame" }));
  const stage = await screen.findByRole("img", { name: /^Page at/ });

  act(() => {
    for (const observer of Observer.all) observer.callback([{ contentRect: { width: 400, height: 300 } } as ResizeObserverEntry], observer);
  });
  await waitFor(() => expect(bodies.some((call) => call.path.endsWith("/resize"))).toBe(true));
  fireEvent.click(stage, { clientX: 200, clientY: 50 });

  await waitFor(() => expect(bodies.some((call) => call.path.endsWith("/input"))).toBe(true));
  const resized = bodies.find((call) => call.path.endsWith("/resize"))?.body;
  const click = bodies.find((call) => call.path.endsWith("/input"))?.body;
  expect(resized).toEqual({ width: 400, height: 300 });
  // Half way across and a sixth of the way down the page it now is, not the 1280 by 800 it was.
  expect(click).toMatchObject({ kind: "click", x: 200, y: 50 });
});

it("keeps the pointer stream and its cue across a navigation of the tab", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", Observer);
  const { rerender, container } = render(<PageView threadId="t" tab={tab} />);
  await waitFor(() => expect(FakeSocket.last?.onmessage).toBeTypeOf("function"));
  act(() => FakeSocket.all.find((socket) => !socket.url.includes("/pointer"))?.onmessage?.({ data: "frame" }));
  await screen.findByRole("img", { name: /^Page at/ });
  const pointers = () => FakeSocket.all.filter((socket) => socket.url.includes("/pointer"));
  expect(pointers()).toHaveLength(1);
  act(() => pointers()[0]?.onmessage?.({ data: JSON.stringify({ sequence: 1, phase: "click", x: 20, y: 30, width: 1280, height: 800 }) }));
  expect(container.querySelector("[data-agent-browser-cursor]")).not.toBeNull();
  // The tab list catches up with the new address after the page has moved on.
  rerender(<PageView threadId="t" tab={{ ...tab, url: "http://localhost:3000/next" }} />);
  expect(pointers()).toHaveLength(1);
  expect(container.querySelector("[data-agent-browser-cursor]")).not.toBeNull();
});
