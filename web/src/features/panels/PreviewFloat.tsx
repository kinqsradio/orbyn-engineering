import { Maximize2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { request } from "../../api/client";
import type { PreviewTab } from "../../api/types";
import { useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { PageView } from "./BrowserPanel";

const POLL_MS = 3000;
const q = encodeURIComponent;

/** A tab an agent opened since the last look, if the Browser panel isn't showing. */
export function newAgentTab(tabs: PreviewTab[], seen: Set<string>): PreviewTab | null {
  const fresh = tabs.filter((tab) => tab.opened_by === "agent" && !seen.has(tab.id));
  return fresh.at(-1) ?? null;
}

/** Asks the service nothing until a page floats or the setting wants to watch. */
export function PreviewFloat({ threadId }: { threadId: string | null }) {
  const float = useUi((state) => state.previewFloat);
  const auto = useUi((state) => state.autoFloatPreview);
  if (!threadId || (!auto && float?.threadId !== threadId)) return null;
  return <FloatHost key={threadId} threadId={threadId} />;
}

/** A page watching over the chat. It stays read-only: control belongs to the panel. */
function FloatHost({ threadId }: { threadId: string }) {
  const float = useUi((state) => state.previewFloat);
  const auto = useUi((state) => state.autoFloatPreview);
  const setFloat = useUi((state) => state.setPreviewFloat);
  const shown = float?.threadId === threadId ? float : null;
  const tabs = useAsync(`preview-float:${threadId}`, (signal) =>
    request<PreviewTab[]>("GET", `/api/threads/${q(threadId)}/previews`, undefined, signal),
  );
  const reload = tabs.reload;
  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const seen = useRef(new Set<string>());
  useEffect(() => {
    const list = tabs.data;
    if (!list) return;
    const fresh = auto ? newAgentTab(list, seen.current) : null;
    for (const tab of list) seen.current.add(tab.id);
    const ui = useUi.getState();
    const showing = ui.panelOpen === true && ui.panelTab === "browser";
    if (fresh && !showing) setFloat({ threadId, tabId: fresh.id });
  }, [tabs.data, auto, threadId, setFloat]);

  const tab = shown ? tabs.data?.find((entry) => entry.id === shown.tabId) : undefined;
  if (!tab) return null;
  return (
    <aside className="preview-float" aria-label="Floating page">
      <div className="preview-float-bar">
        <span>{tab.title || tab.url}</span>
        <IconButton
          label="Open in Browser panel"
          onClick={() => {
            setFloat(null);
            useUi.getState().showInBrowser("");
          }}
        >
          <Maximize2 size={14} aria-hidden />
        </IconButton>
        <IconButton label="Close floating page" onClick={() => setFloat(null)}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <PageView threadId={threadId} tab={tab} fitted={false} />
    </aside>
  );
}
