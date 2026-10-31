import { describe, expect, it, vi } from "vitest";
import { SseParser, followThread, type StreamStatus } from "./sse";
import type { WireThreadEvent } from "./types";

describe("SseParser", () => {
  it("joins frames split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push('id: 1\ndata: {"a"')).toEqual([]);
    expect(parser.push(":1}\n")).toEqual([]);
    expect(parser.push("\n")).toEqual(['{"a":1}']);
  });

  it("handles CRLF, comments and multi-line data", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\r\n\r\ndata: a\r\ndata: b\r\n\r\n")).toEqual(["a\nb"]);
  });

  it("does not treat a CR at a chunk edge as two line ends", () => {
    const parser = new SseParser();
    expect(parser.push("data: a\r")).toEqual([]);
    expect(parser.push("\n\r\n")).toEqual(["a"]);
  });
});

const frame = (seq: number) =>
  `id: ${seq}\ndata: ${JSON.stringify({ seq, thread_id: "t", run_id: null, ts: "", event: { type: "RUN_STARTED", threadId: "t", runId: "r" } })}\n\n`;

const streamOf = (text: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200 },
  );

describe("followThread", () => {
  it("reconnects with Last-Event-ID and reports each state", async () => {
    vi.useFakeTimers();
    const seen: WireThreadEvent[] = [];
    const statuses: StreamStatus[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamOf(frame(1) + frame(2)))
      .mockReturnValue(new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    const stop = followThread("t", {
      onEvents: (events) => seen.push(...events),
      onStatus: (status) => statuses.push(status),
      lastSeq: () => seen.at(-1)?.seq ?? 0,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.map((event) => event.seq)).toEqual([1, 2]);
    expect(statuses).toEqual(["connecting", "live", "reconnecting"]);

    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "Last-Event-ID": "2" });
    stop();
    vi.useRealTimers();
  });

  it("stops without retrying when the thread is gone", async () => {
    const statuses: StreamStatus[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    followThread("t", {
      onEvents: () => undefined,
      onStatus: (status) => statuses.push(status),
      lastSeq: () => 0,
    });
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("failed"));
  });
});
