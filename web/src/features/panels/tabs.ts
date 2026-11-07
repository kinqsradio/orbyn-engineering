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
