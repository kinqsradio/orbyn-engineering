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
  /** Calls a tool on the app's own server, once a person has confirmed it. */
  callTool?(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Sends text as the person's next message, once a person has confirmed it. */
  sendMessage?(text: string): Promise<void>;
  /** Keeps the page's latest note for the model's next turn. */
  updateContext?(text: string): Promise<void>;
  /** Switches between the inline card and the full-screen view; answers the mode now shown. */
  requestDisplayMode?(mode: McpAppDisplayMode): McpAppDisplayMode;
}

export type AppReply = { result: unknown } | { error: { code: number; message: string } };

export const NOT_SUPPORTED = -32601;
export const INVALID_PARAMS = -32602;

const refuse = (code: number, message: string): AppReply => ({ error: { code, message } });

export function hostContext(host: AppHost): Record<string, unknown> {
  return {
    theme: host.theme,
    displayMode: host.displayMode,
    availableDisplayModes: host.requestDisplayMode ? ["inline", "fullscreen"] : ["inline"],
    platform: "web",
  };
}

/** The capabilities this host offers in `ui/initialize`: only what it was given. */
export function hostCapabilities(host: AppHost): Record<string, unknown> {
  return {
    ...(host.callTool ? { serverTools: {} } : {}),
    ...(host.sendMessage ? { message: { text: {} } } : {}),
    ...(host.updateContext ? { updateModelContext: { text: {}, structuredContent: {} } } : {}),
  };
}

/** A note's text: its text blocks, then its structured content as JSON. Empty clears it. */
export function noteText(params: Record<string, unknown>): string | null {
  const blocks = params.content === undefined ? [] : Array.isArray(params.content) ? params.content : [params.content];
  const texts = blocks.map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : null));
  if (texts.includes(null)) return null;
  const parts = texts.filter((text): text is string => !!text && text.trim() !== "");
  if (params.structuredContent !== undefined && params.structuredContent !== null) {
    parts.push(JSON.stringify(params.structuredContent));
  }
  return parts.join("\n").trim();
}

/** A refusal or failure the page sees as a JSON-RPC error, with the reason. */
const failed = (error: unknown): AppReply =>
  refuse(-32000, error instanceof Error && error.message ? error.message : "The host could not do that.");

/** The text of a `ui/message`: user-role text blocks only, one block or a list. */
export function messageText(params: Record<string, unknown>): string | null {
  const blocks = Array.isArray(params.content) ? params.content : [params.content];
  if (params.role !== "user" || blocks.length === 0) return null;
  const texts = blocks.map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : null));
  if (texts.includes(null)) return null;
  const text = texts.join("\n").trim();
  return text === "" ? null : text;
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
          hostCapabilities: hostCapabilities(host),
          hostContext: hostContext(host),
        },
      };
    case "ping":
      return { result: {} };
    case "tools/call": {
      if (!host.callTool) break;
      const { name, arguments: args = {} } = message.params;
      if (typeof name !== "string" || name.trim() === "" || !isRecord(args)) {
        return refuse(INVALID_PARAMS, "tools/call needs a tool name and object arguments.");
      }
      return host.callTool(name, args).then((result) => ({ result }), failed);
    }
    case "ui/message": {
      if (!host.sendMessage) break;
      const text = messageText(message.params);
      if (text === null) return refuse(INVALID_PARAMS, "Only non-empty text from the user role can be sent.");
      return host.sendMessage(text).then(() => ({ result: {} }), failed);
    }
    case "ui/update-model-context": {
      if (!host.updateContext) break;
      const text = noteText(message.params);
      if (text === null) return refuse(INVALID_PARAMS, "A note is text blocks and structured content only.");
      return host.updateContext(text).then(() => ({ result: {} }), failed);
    }
    case "ui/request-display-mode": {
      if (!host.requestDisplayMode) break;
      const mode = message.params.mode;
      if (mode !== "inline" && mode !== "fullscreen") return { result: { mode: host.displayMode } };
      return { result: { mode: host.requestDisplayMode(mode) } };
    }
    case "ui/notifications/size-changed": {
      const height = clampAppHeight(message.params.height);
      if (height !== null) host.resize(height);
      return null;
    }
    default:
      break;
  }
  return message.id === undefined ? null : refuse(NOT_SUPPORTED, `This host does not serve ${message.method}.`);
}

/** The notifications that follow the page's `ui/notifications/initialized`. */
export function toolNotifications(host: AppHost): { method: string; params: unknown }[] {
  return [
    { method: "ui/notifications/tool-input", params: { arguments: host.toolInput } },
    { method: "ui/notifications/tool-result", params: host.toolResult },
  ];
}
