import { ApiFailure, authHeaders } from "./client";
import type { WireThreadEvent } from "./types";

/** Incremental `text/event-stream` parser. Only `data:` carries information here. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match) break;
      // A lone trailing CR might be the first half of CRLF in the next chunk.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (line === "") {
        if (this.data.length > 0) out.push(this.data.join("\n"));
        this.data = [];
      } else if (line.startsWith("data:")) {
        const value = line.slice(5);
        this.data.push(value.startsWith(" ") ? value.slice(1) : value);
      }
    }
    return out;
  }
}

export type StreamStatus = "connecting" | "live" | "reconnecting" | "failed";

export interface StreamHandlers {
  /** Called once per network chunk so replay renders in batches. */
  onEvents(events: WireThreadEvent[]): void;
  onStatus(status: StreamStatus, failure?: ApiFailure): void;
  /** The highest seq this client holds, read on every (re)connect. */
  lastSeq(): number;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

/**
 * Follows a thread's event log. Uses fetch rather than EventSource so the token
 * stays out of the URL and `Last-Event-ID` can carry the client's own position
 * across every kind of reconnect. Returns a stop function.
 */
export function followThread(threadId: string, handlers: StreamHandlers): () => void {
  const controller = new AbortController();
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const retry = () => {
    handlers.onStatus("reconnecting");
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8000;
    attempt += 1;
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async () => {
    const seq = handlers.lastSeq();
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/events`, {
        signal: controller.signal,
        credentials: "same-origin",
        headers: {
          ...authHeaders(),
          Accept: "text/event-stream",
          ...(seq > 0 ? { "Last-Event-ID": String(seq) } : {}),
        },
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        handlers.onStatus(
          "failed",
          new ApiFailure(`http_${response.status}`, "This thread can't be read.", response.status),
        );
        return;
      }
      if (!response.ok || !response.body) {
        retry();
        return;
      }
      handlers.onStatus("live");
      attempt = 0;
      const parser = new SseParser();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const events: WireThreadEvent[] = [];
        for (const data of parser.push(value)) {
          try {
            events.push(JSON.parse(data) as WireThreadEvent);
          } catch {
            // A frame that is not JSON (a comment-like keep-alive) carries nothing.
          }
        }
        if (events.length > 0) handlers.onEvents(events);
      }
      if (!controller.signal.aborted) retry();
    } catch {
      if (!controller.signal.aborted) retry();
    }
  };

  handlers.onStatus("connecting");
  void connect();
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
}
