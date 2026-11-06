import { ArrowUpLeft, Check, Loader2, X } from "lucide-react";
import type { Thread } from "../../api/types";
import { runStateLabels } from "../../lib/format";
import { navigate } from "../../state/route";
import { Button } from "../../ui/controls";
import { threadRunState } from "../workspace/RunState";
import type { SubagentActivity } from "./projection";

const DONE = /^(completed|done|finished|success)/i;
const FAILED = /^(failed|errored|error|cancel)/i;

/** Delegated agents the engine reported on this turn, one chip each, above the composer. */
export function SubagentChips({ agents }: { agents: readonly SubagentActivity[] }) {
  if (agents.length === 0) return null;
  return (
    <ul className="subagent-chips" aria-label="Subagents">
      {agents.map((agent) => {
        const status = agent.status ?? "";
        const name = agent.agentPath?.split(/[/\\]/).filter(Boolean).pop() ?? agent.tool ?? "Subagent";
        const state = DONE.test(status) ? "done" : FAILED.test(status) ? "failed" : "running";
        return (
          <li key={agent.id} className="subagent-chip" data-state={state}>
            {state === "running" ? (
              <Loader2 size={12} className="spin" aria-hidden />
            ) : state === "done" ? (
              <Check size={12} aria-hidden />
            ) : (
              <X size={12} aria-hidden />
            )}
            <span>{name}</span>
            <span className="subagent-chip-status">{status ? status.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "working"}</span>
          </li>
        );
      })}
    </ul>
  );
}

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
