import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentCursor } from "./AgentCursor";

class Socket {
  static last: Socket;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor() { Socket.last = this; }
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("expires cues, ignores older sequences and detaches its stream on a tab switch", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  const image = createRef<HTMLImageElement>();
  const { container, rerender } = render(<><img ref={image} alt="fixture" /><AgentCursor threadId="t" tabId="one" image={image} /></>);
  const first = Socket.last;
  const send = (sequence: number, phase = "click") => act(() => first.onmessage?.({ data: JSON.stringify({ sequence, phase, x: 20, y: 30, width: 100, height: 100 }) }));
  send(2);
  expect(container.querySelector("[data-agent-browser-cursor]")).not.toBeNull();
  send(1, "clear");
  expect(container.querySelector("[data-agent-browser-cursor]")).not.toBeNull();
  act(() => vi.advanceTimersByTime(701));
  expect(container.querySelector("[data-agent-browser-cursor]")).toBeNull();
  send(3);
  send(4, "clear");
  expect(container.querySelector("[data-agent-browser-cursor]")).toBeNull();
  rerender(<><img ref={image} alt="fixture" /><AgentCursor key="two" threadId="t" tabId="two" image={image} /></>);
  expect(first.close).toHaveBeenCalledOnce();
  expect(first.onmessage).toBeNull();
  expect(container.querySelector("[data-agent-browser-cursor]")).toBeNull();
});
