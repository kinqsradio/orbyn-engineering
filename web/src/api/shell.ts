import { authHeaders } from "./client";
import { SseParser } from "./sse";
import type { ShellEvent } from "./types";

const RETRY_MS = 3000;

/**
 * Follows what the desktop shell sends the window. On a plain server nothing ever
 * arrives, and the open stream costs one idle connection. Returns a stop function.
 */
export function followShell(onEvent: (event: ShellEvent) => void): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = async () => {
    try {
      const response = await fetch("/api/shell/events", {
        signal: controller.signal,
        credentials: "same-origin",
        headers: { ...authHeaders(), Accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) throw new Error("no stream");
      const parser = new SseParser();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const data of parser.push(value)) {
          try {
            onEvent(JSON.parse(data) as ShellEvent);
          } catch {
            // A frame this version can't read carries nothing for it.
          }
        }
      }
    } catch {
      // Retried below, unless this stream was stopped.
    }
    if (!controller.signal.aborted) timer = setTimeout(() => void connect(), RETRY_MS);
  };

  void connect();
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
}
