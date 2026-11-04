import { Globe } from "lucide-react";
import { useState } from "react";
import type { PreviewTab } from "../../api/types";
import { iconUrl, proxyIconUrl, useBrowserHistory } from "./browserHistory";

/** Failed and refused icons keep the neutral tab identity, without remote fallback. */
export function SiteIcon({ tab }: { tab: Pick<PreviewTab, "url" | "private" | "favicon_url"> }) {
  const icons = useBrowserHistory((state) => state.icons);
  const declared = iconUrl(tab.favicon_url);
  const icon = declared ?? (tab.private ? null : icons.find((entry) => entry.page === tab.url.split("#")[0])?.icon ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  return icon && failed !== icon ? (
    <img className="browser-tab-icon" src={proxyIconUrl(icon)} alt="" width={14} height={14}
      onLoad={() => { if (!tab.private) useBrowserHistory.getState().remember(tab.url, icon); }}
      onError={() => setFailed(icon)} />
  ) : <Globe size={14} aria-hidden />;
}
