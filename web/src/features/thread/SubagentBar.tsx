import { ArrowUpLeft } from "lucide-react";
import type { Thread } from "../../api/types";
import { runStateLabels } from "../../lib/format";
import { navigate } from "../../state/route";
import { Button } from "../../ui/controls";
import { threadRunState } from "../workspace/RunState";

/** A delegated thread runs by itself, so this stands where the composer would be. */
export function SubagentBar({ thread }: { thread: Thread }) {
  const parent = thread.lifecycle?.parent_thread_id ?? null;
  const state = threadRunState(thread);
  return (
    <div className="subagent-bar" role="status">
      <strong>{thread.model ?? thread.engine}</strong>
      {thread.effort ? <span>{thread.effort}</span> : null}
      <span>{state ? runStateLabels[state] : "Idle"}</span>
      <span className="composer-spacer" />
      <span>Runs on its own</span>
      {parent ? (
        <Button small tone="quiet" icon={<ArrowUpLeft size={14} aria-hidden />} onClick={() => navigate({ name: "thread", id: parent })}>
          Open parent
        </Button>
      ) : null}
    </div>
  );
}
