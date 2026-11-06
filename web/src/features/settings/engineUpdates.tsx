import { create } from "zustand";
import { authHeaders } from "../../api/client";
import { serviceUrl } from "../../api/origin";
import { SseParser } from "../../api/sse";
import type { EngineUpdateProgress } from "../../generated/EngineUpdateProgress";

const RETRY_MS = 3000;

interface EngineUpdates {
  /** Each engine updating now, with what its installer last said. */
  running: Record<string, string>;
  apply(event: EngineUpdateProgress): void;
  clear(): void;
}

export const useEngineUpdates = create<EngineUpdates>((set) => ({
  running: {},
  apply: (event) =>
    set(({ running }) => {
      const next = { ...running };
      if (event.kind === "finished") delete next[event.engine];
      else next[event.engine] = event.kind === "started" ? event.command : event.line;
      return { running: next };
    }),
  clear: () => set({ running: {} }),
}));

/**
 * Follows engine updates while the providers page is open, so a running installer's
 * latest line shows. Returns a stop function.
 */
export function followEngineUpdates(): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const { apply, clear } = useEngineUpdates.getState();

  const connect = async () => {
    try {
      const response = await fetch(serviceUrl("/api/engines/update-events"), {
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
            apply(JSON.parse(data) as EngineUpdateProgress);
          } catch {
            // A frame this version can't read carries nothing for it.
          }
        }
      }
    } catch {
      // Retried below, unless this stream was stopped.
    }
    // A `finished` may have been missed, so nothing shown can be trusted any more.
    clear();
    if (!controller.signal.aborted) timer = setTimeout(() => void connect(), RETRY_MS);
  };

  void connect();
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** The running installer's latest line for one engine, or for whichever is running. */
export function UpdateProgressLine({ engine }: { engine?: string }) {
  const line = useEngineUpdates((state) =>
    engine === undefined ? Object.values(state.running)[0] : state.running[engine],
  );
  if (!line) return null;
  return (
    <p className="muted update-progress" role="status" aria-live="polite">
      {line}
    </p>
  );
}
