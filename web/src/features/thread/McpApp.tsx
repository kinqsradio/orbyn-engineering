import { useEffect, useRef, useState } from "react";
import { resolveTheme, useUi } from "../../state/ui";
import {
  answerApp,
  appFrameSrc,
  DEFAULT_APP_HEIGHT,
  readAppMessage,
  toolNotifications,
  type AppHost,
} from "./mcpAppBridge";
import type { ToolItem } from "./projection";

const parseArgs = (args: string): unknown => {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
};

/**
 * An MCP App's page beside its tool row. The frame is the C21 sandbox: scripts only,
 * an opaque origin and no network, opened by this render's own token. Messages are
 * taken only from this frame's window, and answers go only to it.
 */
export function McpApp({ item, threadId }: { item: ToolItem; threadId: string | null }) {
  const theme = resolveTheme(useUi((state) => state.theme));
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_APP_HEIGHT);
  const app = item.app;
  const host = useRef<AppHost | null>(null);
  host.current = app
    ? {
        theme,
        displayMode: "inline",
        toolInput: parseArgs(item.args),
        toolResult: {
          content: [{ type: "text", text: item.result ?? "" }],
          ...(app.structuredContent == null ? {} : { structuredContent: app.structuredContent }),
        },
        resize: setHeight,
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

  if (!app || !threadId) return null;
  return (
    <figure className="render-card mcp-app" data-border={app.prefersBorder || undefined}>
      <figcaption>
        <span className="render-title" title={app.resourceUri}>
          {app.server} · {app.tool}
        </span>
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
    </figure>
  );
}
