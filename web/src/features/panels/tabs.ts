import { Activity, FileDiff, SquareTerminal } from "lucide-react";
import type { ContextTab } from "../../state/ui";

export const CONTEXT_TABS: { id: ContextTab; label: string; icon: typeof FileDiff }[] = [
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "activity", label: "Activity", icon: Activity },
];
