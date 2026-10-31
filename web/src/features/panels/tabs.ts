import { Activity, FileDiff, GitPullRequest } from "lucide-react";
import type { RightTab } from "../../state/ui";

export const RIGHT_TABS: { id: RightTab; label: string; icon: typeof FileDiff }[] = [
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest },
];
