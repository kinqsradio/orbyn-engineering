import { Activity, AppWindow, FileDiff, Files, GitPullRequest, MessagesSquare } from "lucide-react";
import type { RightTab } from "../../state/ui";

/** The panel's six fixed tabs, in the order the design shows. `text` is what the tab reads, `label` its name. */
export const RIGHT_TABS: { id: RightTab; label: string; text: string; icon: typeof FileDiff }[] = [
  { id: "diff", label: "Diff", text: "Diff", icon: FileDiff },
  { id: "files", label: "Files", text: "Files", icon: Files },
  { id: "browser", label: "Browser", text: "Browser", icon: AppWindow },
  { id: "activity", label: "Activity", text: "Activity", icon: Activity },
  { id: "pulls", label: "Pull requests", text: "PRs", icon: GitPullRequest },
  { id: "side", label: "Side chat", text: "Side chat", icon: MessagesSquare },
];

/**
 * Which tabs stay in the row when the panel is narrow; the rest fold into More. The open tab always
 * stays. `room` is the row's width when no More button sits beside it, `moreWidth` what that button
 * takes. Tabs keep their order, and a tab with no measured width is kept.
 */
export function fitTabs(ids: readonly RightTab[], widths: ReadonlyMap<RightTab, number>, room: number, moreWidth: number, open: RightTab | null): RightTab[] {
  const width = (id: RightTab) => widths.get(id) ?? 0;
  if (ids.reduce((sum, id) => sum + width(id), 0) <= room) return [...ids];
  let left = room - moreWidth - (open && ids.includes(open) ? width(open) : 0);
  const kept = new Set<RightTab>(open && ids.includes(open) ? [open] : []);
  for (const id of ids) {
    if (kept.has(id)) continue;
    if (width(id) > left) break;
    left -= width(id);
    kept.add(id);
  }
  return ids.filter((id) => kept.has(id));
}
