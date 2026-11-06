import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { resolveTheme, useUi } from "../../state/ui";
import { Button } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import {
  answerApp,
  appFrameSrc,
  DEFAULT_APP_HEIGHT,
  readAppMessage,
  toolNotifications,
  type AppHost,
  type McpAppDisplayMode,
} from "./mcpAppBridge";
import type { ToolItem } from "./projection";

const parseArgs = (args: string): unknown => {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
};

/** A request from the page that waits for the person. */
interface Ask {
  title: string;
  label: string;
  detail: string;
  run(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * An MCP App's page beside its tool row. The frame is the C21 sandbox: scripts only,
 * an opaque origin and no network, opened by this render's own token. Messages are
 * taken only from this frame's window, and answers go only to it. A tool call or a
 * message the page asks for waits for the person in this host's own dialog, which
 * the page cannot reach, and the service checks the policy rules again.
 */
export function McpApp({ item, threadId }: { item: ToolItem; threadId: string | null }) {
  const theme = resolveTheme(useUi((state) => state.theme));
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_APP_HEIGHT);
  const [display, setDisplay] = useState<McpAppDisplayMode>("inline");
  const [ask, setAsk] = useState<Ask | null>(null);
  const app = item.app;
  const host = useRef<AppHost | null>(null);

  const confirm = (title: string, label: string, detail: string, run: () => Promise<unknown>) =>
    new Promise<unknown>((resolve, reject) => setAsk({ title, label, detail, run, resolve, reject }));

  host.current =
    app && threadId
      ? {
          theme,
          displayMode: display,
          toolInput: parseArgs(item.args),
          toolResult: {
            content: [{ type: "text", text: item.result ?? "" }],
            ...(app.structuredContent == null ? {} : { structuredContent: app.structuredContent }),
          },
          resize: setHeight,
          callTool: (name, args) =>
            confirm(
              `${app.server} wants to run ${name}`,
              "Run tool",
              JSON.stringify(args, null, 2),
              () => api.mcpAppToolCall(threadId, app.renderId, name, args),
            ),
          sendMessage: (text) =>
            confirm(`${app.server} wants to send a message`, "Send", text, () =>
              api.mcpAppMessage(threadId, app.renderId, text),
            ).then(() => undefined),
          requestDisplayMode: (mode) => {
            setDisplay(mode);
            return mode;
          },
        }
      : null;

  useEffect(() => {
    if (!app) return;
    const post = (message: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
    const listen = (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source || !host.current) return;
      const message = readAppMessage(event.data);
      if (!message) return;
      if (message.method === "ui/notifications/initialized") {
        for (const note of toolNotifications(host.current)) post(note);
        return;
      }
      void answerApp(message, host.current).then((reply) => {
        if (reply && message.id !== undefined) post({ id: message.id, ...reply });
      });
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [app]);

  // The page hears the mode it is shown in, whoever changed it.
  useEffect(() => {
    if (!app || !host.current) return;
    frame.current?.contentWindow?.postMessage(
      { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: display } },
      "*",
    );
  }, [app, display]);

  useEffect(() => {
    if (display !== "fullscreen") return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !ask) setDisplay("inline");
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [display, ask]);

  if (!app || !threadId) return null;
  const full = display === "fullscreen";
  return (
    <figure className="render-card mcp-app" data-border={app.prefersBorder || undefined} data-display={display}>
      <figcaption>
        <span className="render-title" title={app.resourceUri}>
          {app.server} · {app.tool}
        </span>
        <Button
          small
          tone="quiet"
          icon={full ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
          onClick={() => setDisplay(full ? "inline" : "fullscreen")}
        >
          {full ? "Exit full screen" : "Full screen"}
        </Button>
      </figcaption>
      <div className="render-body" style={{ height }}>
        <iframe
          ref={frame}
          className="render-frame"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={`${app.server} ${app.tool}`}
          src={appFrameSrc(app, threadId)}
          style={{ colorScheme: theme, width: "100%", height }}
        />
      </div>
      {ask ? (
        <ConfirmDialog
          title={ask.title}
          confirmLabel={ask.label}
          onConfirm={async () => {
            // A refusal from the service reaches the page as its error and stays
            // in the dialog for the person; a later Cancel changes nothing.
            try {
              ask.resolve(await ask.run());
            } catch (error) {
              ask.reject(error instanceof Error ? error : new Error(String(error)));
              throw error;
            }
            setAsk(null);
          }}
          onClose={() => {
            ask.reject(new Error("The person declined."));
            setAsk(null);
          }}
        >
          <div className="mcp-app-ask">
            <p>This request comes from the app's page, not from the agent.</p>
            <pre tabIndex={0}>{ask.detail}</pre>
          </div>
        </ConfirmDialog>
      ) : null}
    </figure>
  );
}
