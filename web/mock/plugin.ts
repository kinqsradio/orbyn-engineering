/** Dev-server only (`apply: "serve"`). Nothing here reaches a production build. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { WebSocketServer } from "ws";
import { createMockApi, type Scenario } from "./api.ts";

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });

export function mockApi(): Plugin {
  const mock = createMockApi();
  const streams = new Set<ServerResponse>();

  const stream = (req: IncomingMessage, res: ServerResponse, threadId: string) => {
    const header = req.headers["last-event-id"];
    const after = Number(Array.isArray(header) ? header[0] : (header ?? 0)) || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: { seq: number }) =>
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of mock.events(threadId, after)) send(event);
    const stop = mock.subscribe(threadId, send);
    streams.add(res);
    req.on("close", () => {
      stop();
      streams.delete(res);
    });
  };

  return {
    name: "orbyn-mock-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        const send = (status: number, body?: unknown) => {
          res.statusCode = status;
          if (body !== undefined) res.setHeader("Content-Type", "application/json");
          res.end(body === undefined ? undefined : JSON.stringify(body));
        };

        if (url.startsWith("/__mock/")) {
          const [, , command, arg] = url.split("?")[0]?.split("/") ?? [];
          const params = new URL(url, "http://mock.local").searchParams;
          if (command === "scenario") {
            mock.reset((arg ?? "default") as Scenario);
            res.statusCode = 302;
            res.setHeader("Location", params.get("to") ?? "/");
            res.end();
            return;
          }
          if (command === "drop-streams") {
            for (const open of streams) open.destroy();
            streams.clear();
            send(200, { dropped: true });
            return;
          }
          if (command === "fail") {
            mock.fail(params.get("path") ?? "/api", Number(params.get("times") ?? 1));
            send(200, { armed: true });
            return;
          }
          if (command === "delay") {
            mock.delayMs = Number(arg ?? 0);
            send(200, { delay: mock.delayMs });
            return;
          }
          send(404);
          return;
        }

        const events = /^\/api\/threads\/([^/?]+)\/events/.exec(url);
        if (events) {
          const failed = mock.handle("GET", "/api/info");
          if (failed.status >= 400) {
            send(failed.status, failed.body);
            return;
          }
          stream(req, res, decodeURIComponent(events[1] ?? ""));
          return;
        }

        if (!url.startsWith("/api/") && !url.startsWith("/auth/")) {
          next();
          return;
        }
        const body = req.method === "GET" ? undefined : await readBody(req);
        if (mock.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
        const result = mock.handle(req.method ?? "GET", url, body);
        send(result.status, result.body);
      });

      const wss = new WebSocketServer({ noServer: true });
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (!req.url?.startsWith("/ws/terminal/")) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          const prompt = "\x1b[32mdev@mock\x1b[0m:\x1b[34m~/code/orbyn-engineering-app\x1b[0m$ ";
          ws.send(Buffer.from(`Mock terminal. Keystrokes echo back.\r\n${prompt}`));
          ws.on("message", (data, isBinary) => {
            if (!isBinary) {
              const size = JSON.parse(data.toString()) as { cols: number; rows: number };
              ws.send(Buffer.from(`\r\n[resized to ${size.cols}x${size.rows}]\r\n${prompt}`));
              return;
            }
            const text = data.toString();
            ws.send(Buffer.from(text === "\r" ? `\r\n${prompt}` : text));
          });
        });
      });
    },
  };
}
