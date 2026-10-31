import { api, authHeaders } from "./client";
import { SseParser } from "./sse";
import type { ShellAction, ShellEvent } from "./types";

const RETRY_MS = 3000;

let attached = false;

/** True in the desktop app, once the service has said so. */
export const inDesktopApp = () => attached;

export async function readShellStatus(signal?: AbortSignal) {
  const status = await api.shell(signal);
  attached = status.attached;
  return status;
}

/** Zoom keys the native menu doesn't catch: the keypad, and Cmd with the shifted `+`. */
export function zoomKeyAction(event: KeyboardEvent): ShellAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.code === "NumpadAdd" || event.key === "+") return "zoom_in";
  if (event.code === "NumpadSubtract") return "zoom_out";
  if (event.code === "Numpad0") return "zoom_reset";
  return null;
}

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
