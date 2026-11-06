import { CircleCheck, CircleX, LoaderCircle, Square, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, request } from "../../api/client";
import type { TerminalInfo, Thread } from "../../api/types";
import type { ThreadSetup } from "../../generated/ThreadSetup";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button } from "../../ui/controls";

/** How often a setup that is still going is read again. */
const POLL_MS = 1000;

const live = (setup: ThreadSetup | null | undefined) => setup?.phase === "preparing" || setup?.phase === "running";

function describe(setup: ThreadSetup): string {
  switch (setup.phase) {
    case "preparing":
      return `Starting setup: ${setup.name}`;
    case "running":
      return setup.blocking ? `Running setup: ${setup.name}. The first turn waits for it.` : `Running setup: ${setup.name}`;
    case "finished":
      return setup.exit_code === 0 ? `Setup ${setup.name} finished` : `Setup ${setup.name} exited with code ${setup.exit_code ?? "?"}`;
    case "stopped":
      return `Setup ${setup.name} stopped before it finished`;
  }
}

/**
 * A new worktree's setup action: where it stands, its output and a way to stop it.
 * Core owns the process and the first-turn gate; this only reads and asks.
 */
export function WorktreeSetupCard({ thread }: { thread: Thread }) {
  const pushToast = useUi((state) => state.pushToast);
  const revealTerminal = useUi((state) => state.revealTerminal);
  const state = useAsync(`setup:${thread.id}`, (signal) => api.threadSetup(thread.id, signal));
  const [cancelling, setCancelling] = useState(false);
  const [faded, setFaded] = useState<string | null>(null);
  const pending = useRef(false);
  const setup = state.data;
  const going = live(setup);
  const succeeded = setup?.phase === "finished" && setup.exit_code === 0;
  const { reload } = state;
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [going, reload]);
  // A successful setup stays a moment, so its result is seen, then leaves.
  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(() => setFaded(thread.id), 4000);
    return () => clearTimeout(timer);
  }, [succeeded, thread.id]);
  if (!setup || !thread.worktree || (succeeded && faded === thread.id)) return null;
  const cancel = () => {
    if (pending.current) return;
    pending.current = true;
    setCancelling(true);
    api.cancelSetup(thread.id).then(
      (next) => state.setData(next),
      (error: unknown) => pushToast(`Couldn't cancel setup. ${toFailure(error).message}`),
    ).finally(() => {
      pending.current = false;
      setCancelling(false);
    });
  };
  const showOutput = () => {
    request<TerminalInfo[]>("GET", `/api/threads/${encodeURIComponent(thread.id)}/terminals`).then(
      (terminals) => {
        const terminal = terminals.find((entry) => entry.id === setup.terminal_id);
        if (terminal) revealTerminal(thread.id, terminal.group);
        else pushToast("The setup terminal is closed.");
      },
      (error: unknown) => pushToast(`Couldn't open setup output. ${toFailure(error).message}`),
    );
  };
  const failed = setup.phase === "stopped" || (setup.phase === "finished" && setup.exit_code !== 0);
  const Icon = going ? LoaderCircle : failed ? CircleX : CircleCheck;
  return (
    <div className={`setup-card${failed ? " failed" : ""}`} role="status" aria-label="Worktree setup">
      <p className="setup-title">
        <Icon size={14} aria-hidden className={going ? "spin" : undefined} />
        Working in a new worktree
      </p>
      <p className="setup-kv">
        <span>Path</span>
        <b className="mono" title={thread.worktree.path}>
          {thread.worktree.path}
        </b>
      </p>
      <p className="setup-kv">
        <span>Branch</span>
        <b className="mono">{thread.worktree.branch}</b>
      </p>
      <div className="setup-kv">
        <span>Setup</span>
        <b>{describe(setup)}</b>
        {setup.terminal_id ? (
          <Button small tone="quiet" icon={<SquareTerminal size={12} aria-hidden />} onClick={showOutput}>
            Output
          </Button>
        ) : null}
        {setup.cancellable ? (
          <Button small tone="quiet" disabled={cancelling} icon={<Square size={12} aria-hidden />} onClick={cancel}>
            Cancel setup
          </Button>
        ) : null}
      </div>
    </div>
  );
}
