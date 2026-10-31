import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Hand,
  Loader2,
  OctagonAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import type { RunState, Thread } from "../../api/types";
import { runStateLabels } from "../../lib/format";
import { Pill, type PillTone } from "../../ui/controls";

const presentation: Record<RunState, { icon: LucideIcon; tone: PillTone; spin?: boolean }> = {
  admitted: { icon: CircleDashed, tone: "neutral" },
  starting: { icon: Loader2, tone: "accent", spin: true },
  running: { icon: Loader2, tone: "accent", spin: true },
  awaiting_approval: { icon: Hand, tone: "warn" },
  completed: { icon: CircleCheck, tone: "neutral" },
  failed: { icon: OctagonAlert, tone: "danger" },
  cancelled: { icon: CircleSlash, tone: "neutral" },
  interrupted: { icon: Unplug, tone: "warn" },
};

/** The server's current state for a thread. The UI derives nothing further. */
export const threadRunState = (thread: Thread): RunState | null =>
  thread.active_run?.state ?? thread.last_run_state;

export function RunStatePill({ state }: { state: RunState }) {
  const { icon: Icon, tone, spin } = presentation[state];
  return (
    <Pill tone={tone}>
      <Icon size={16} className={spin ? "spin" : undefined} aria-hidden />
      {runStateLabels[state]}
    </Pill>
  );
}

export function RunStateIcon({ state }: { state: RunState | null }) {
  if (!state) return <span className="state-dot" aria-hidden />;
  const { icon: Icon, tone, spin } = presentation[state];
  return (
    <span className={`state-icon state-${tone}`}>
      <Icon size={16} className={spin ? "spin" : undefined} aria-hidden />
      <span className="sr-only">{runStateLabels[state]}</span>
    </span>
  );
}
