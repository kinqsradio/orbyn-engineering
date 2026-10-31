import { readToken } from "../../api/token";

export function terminalUrl(
  threadId: string,
  location: Pick<Location, "protocol" | "host"> = window.location,
  terminalId?: string,
): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const token = readToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${scheme}//${location.host}/ws/terminal/${encodeURIComponent(threadId)}${terminalId ? `/${encodeURIComponent(terminalId)}` : ""}${query}`;
}
