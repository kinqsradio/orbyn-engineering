import { readToken } from "../../api/token";

export function terminalUrl(
  threadId: string,
  location: Pick<Location, "protocol" | "host"> = window.location,
  terminalId?: string,
  observe = false,
): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const token = readToken();
  const params = [...(token ? [`token=${encodeURIComponent(token)}`] : []), ...(observe ? ["observe=true"] : [])];
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `${scheme}//${location.host}/ws/terminal/${encodeURIComponent(threadId)}${terminalId ? `/${encodeURIComponent(terminalId)}` : ""}${query}`;
}
