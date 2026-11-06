/**
 * MCP Apps: the page a tool's descriptor names, stored by the service as one of the
 * thread's renders. The page is untrusted. It runs in the C21 sandbox with only its
 * own `?render=` token, and talks to this host over `postMessage` JSON-RPC. The host
 * answers only what it supports and refuses everything else.
 */

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
/** A render id: lowercase ULID text, and nothing else. */
const RENDER_ID = /^[0-9a-z]{1,64}$/;
const FRAME_TOKEN = /^[0-9a-f]{16,128}$/;
export const MIN_APP_HEIGHT = 80;
export const DEFAULT_APP_HEIGHT = 320;
export const MAX_APP_HEIGHT = 2000;
const MAX_NAME = 256;

export type McpAppDisplayMode = "inline" | "fullscreen";

/** What the `mcp_app` timeline marker says about one tool row's page. */
export interface McpAppView {
  renderId: string;
  frameToken: string;
  server: string;
  tool: string;
  resourceUri: string;
  displayMode: McpAppDisplayMode;
  prefersBorder: boolean;
  structuredContent: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const name = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_NAME ? value : null;

/** Reads an `mcp_app` marker, or null when anything in it is not what the service writes. */
export function readMcpAppMarker(value: unknown): (McpAppView & { toolCallId: string }) | null {
  if (!isRecord(value)) return null;
  const { toolCallId, renderId, frameToken, resourceUri } = value;
  const server = name(value.server);
  const tool = name(value.tool);
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  if (typeof renderId !== "string" || !RENDER_ID.test(renderId)) return null;
  if (typeof frameToken !== "string" || !FRAME_TOKEN.test(frameToken)) return null;
  if (typeof resourceUri !== "string" || !resourceUri.startsWith("ui://")) return null;
  if (!server || !tool) return null;
  return {
    toolCallId,
    renderId,
    frameToken,
    server,
    tool,
    resourceUri,
    displayMode: value.displayMode === "fullscreen" ? "fullscreen" : "inline",
    prefersBorder: value.prefersBorder === true,
    structuredContent: value.structuredContent ?? null,
  };
}

/** The page's frame URL: the render route with this render's own token, never the service token. */
export function appFrameSrc(app: McpAppView, threadId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/renders/${app.renderId}?render=${encodeURIComponent(app.frameToken)}`;
}

export const clampAppHeight = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_APP_HEIGHT, Math.max(MIN_APP_HEIGHT, Math.round(value)))
    : null;

/** A JSON-RPC message the page sent, as far as the host reads it. */
export interface AppMessage {
  id?: string | number;
  method: string;
  params: Record<string, unknown>;
}

export function readAppMessage(data: unknown): AppMessage | null {
  if (!isRecord(data) || data.jsonrpc !== "2.0" || typeof data.method !== "string") return null;
  const id = data.id;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") return null;
  return { ...(id === undefined ? {} : { id }), method: data.method, params: isRecord(data.params) ? data.params : {} };
}

/** What the host can do for a page, beyond showing it. Each is optional. */
export interface AppHost {
  theme: "light" | "dark";
  displayMode: McpAppDisplayMode;
  /** The tool call's arguments, as the row shows them. */
  toolInput: unknown;
  /** The tool call's result, as the page's `tool-result` notification carries it. */
  toolResult: { content: unknown[]; structuredContent?: unknown };
  /** Resize the inline frame. */
  resize(height: number): void;
}

export type AppReply = { result: unknown } | { error: { code: number; message: string } };

export const NOT_SUPPORTED = -32601;
export const INVALID_PARAMS = -32602;

const refuse = (code: number, message: string): AppReply => ({ error: { code, message } });

export function hostContext(host: AppHost): Record<string, unknown> {
  return {
    theme: host.theme,
    displayMode: host.displayMode,
    availableDisplayModes: ["inline"],
    platform: "web",
  };
}

/** The capabilities this host offers in `ui/initialize`. */
export function hostCapabilities(): Record<string, unknown> {
  return {};
}

/**
 * Answers one request from the page. Notifications get no answer and return null;
 * a request the host does not serve is refused, never left hanging.
 */
export async function answerApp(message: AppMessage, host: AppHost): Promise<AppReply | null> {
  switch (message.method) {
    case "ui/initialize":
      return {
        result: {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "Orbyn", version: "1" },
          hostCapabilities: hostCapabilities(),
          hostContext: hostContext(host),
        },
      };
    case "ping":
      return { result: {} };
    case "ui/notifications/size-changed": {
      const height = clampAppHeight(message.params.height);
      if (height !== null) host.resize(height);
      return null;
    }
    default:
      return message.id === undefined ? null : refuse(NOT_SUPPORTED, `This host does not serve ${message.method}.`);
  }
}

/** The notifications that follow the page's `ui/notifications/initialized`. */
export function toolNotifications(host: AppHost): { method: string; params: unknown }[] {
  return [
    { method: "ui/notifications/tool-input", params: { arguments: host.toolInput } },
    { method: "ui/notifications/tool-result", params: host.toolResult },
  ];
}
