import { request } from "../../api/client";
import type { TerminalInfo } from "../../api/types";
import type { ProjectScript } from "../../generated/ProjectScript";
import { parseRoute } from "../../state/route";
import { useUi } from "../../state/ui";
import { openActionPreview } from "./actionPreview";

/** Menus and shortcuts select the same real terminal, with optional preview afterward. */
export async function runProjectAction(threadId: string, script: ProjectScript): Promise<void> {
  const terminal = await request<TerminalInfo>("POST", `/api/threads/${encodeURIComponent(threadId)}/scripts`,
    script.id ? { id: script.id } : { name: script.name });
  const route = parseRoute(window.location.hash);
  if (route.name !== "thread" || route.id !== threadId) return;
  useUi.getState().revealTerminal(threadId, terminal.group);
  await openActionPreview(threadId, script);
}
