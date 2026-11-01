import { request } from "../../api/client";
import type { PreviewTab } from "../../api/types";
import type { ProjectScript } from "../../generated/ProjectScript";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { parseRoute } from "../../state/route";

/** A successfully launched action may bring its saved URL into the Browser. */
export async function openActionPreview(threadId: string, script: ProjectScript): Promise<void> {
  if (!script.auto_open_preview || !script.preview_url) return;
  try {
    const tab = await request<PreviewTab>("POST", `/api/threads/${encodeURIComponent(threadId)}/previews`, { url: script.preview_url });
    const route = parseRoute(window.location.hash);
    if (route.name === "thread" && route.id === threadId) {
      useUi.getState().showInBrowser({ tabId: tab.id });
    }
  } catch (failure) {
    // The command already started; preview failure must not report it as failed.
    useUi.getState().pushToast(`Could not open preview. ${toFailure(failure).message}`);
  }
}
