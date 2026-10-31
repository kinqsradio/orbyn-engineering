/** Serves the mock API through a stubbed fetch, including a live SSE stream. */
import { vi } from "vitest";
import { createMockApi, type MockApi } from "../mock/api";

export function installMockFetch(options: { stepMs?: number } = {}): MockApi {
  const mock = createMockApi({ stepMs: options.stepMs ?? 0 });
  const encoder = new TextEncoder();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const events = /^\/api\/threads\/([^/?]+)\/events/.exec(input);
      if (events) {
        const id = decodeURIComponent(events[1] ?? "");
        const header = new Headers(init?.headers).get("Last-Event-ID");
        const status = mock.handle("GET", "/api/info");
        if (status.status >= 400) {
          return new Response(JSON.stringify(status.body), { status: status.status });
        }
        let stop = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: { seq: number }) =>
              controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
            for (const event of mock.events(id, Number(header ?? 0))) send(event);
            stop = mock.subscribe(id, send);
            init?.signal?.addEventListener("abort", () => {
              stop();
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
          cancel: () => stop(),
        });
        return new Response(body, { status: 200 });
      }
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const result = mock.handle(method, input, body);
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
      });
    }),
  );
  return mock;
}
