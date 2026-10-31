import { TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { EngineLimits, EngineStatus, JsonValue } from "../../api/types";
import { relativeTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useThreadLogs } from "../../state/threadLogs";
import { useWorkspace } from "../../state/workspace";
import { Button, IconButton } from "../../ui/controls";
import type { StashedPrompt } from "../../state/ui";

const usageShare = (usage: JsonValue | null | undefined): { used: number; window: number } | null => {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const used = usage.total_tokens;
  const window = usage.context_window;
  return typeof used === "number" && typeof window === "number" && window > 0 ? { used, window } : null;
};

const compactCount = (value: number) => (value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value));

/** How full the context window is, as the engine last reported it. */
/** The ring alone reads as a spinner when little is used, so the number sits beside it. */
export const percentLabel = (value: number) =>
  value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`;

export function ContextMeter({ threadId }: { threadId: string }) {
  const usage = useThreadLogs((state) => state.logs[threadId]?.usage);
  const share = usageShare(usage);
  if (!share) return null;
  const percent = Math.min((share.used / share.window) * 100, 100);
  const shown = percentLabel(percent);
  const label = `Context ${shown} used, ${compactCount(share.used)} of ${compactCount(share.window)} tokens`;
  return (
    <span className="context-meter" role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
        <circle cx="12" cy="12" r="9.75" pathLength="100" />
        <circle cx="12" cy="12" r="9.75" pathLength="100" strokeDasharray={`${percent} 100`} />
      </svg>
      <span aria-hidden>{shown}</span>
    </span>
  );
}

/** How long a run gets to answer Stop before Force stop is offered. */
export const FORCE_STOP_AFTER_MS = 3000;

/** A Stop the engine has not finished, and the way out once it stops answering. */
export function StopNotice({ threadId, runId }: { threadId: string; runId: string }) {
  const [late, setLate] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), FORCE_STOP_AFTER_MS);
    return () => clearTimeout(timer);
  }, [runId]);
  if (!late) return null;
  const force = () => {
    setForcing(true);
    setError(null);
    api.forceStop(threadId).then(
      () => void useWorkspace.getState().refreshThread(threadId),
      (failure: unknown) => {
        setError(`Couldn't force stop. ${toFailure(failure).message}`);
        setForcing(false);
      },
    );
  };
  return (
    <p className="composer-banner" role="status">
      <TriangleAlert size={14} aria-hidden />
      <span>{error ?? "Agent not responding to Stop. Force stop kills its processes."}</span>
      <Button small tone="quiet" disabled={forcing} onClick={force}>
        {forcing ? "Force stopping..." : "Force stop"}
      </Button>
    </p>
  );
}

/** Says why the selected engine can't run, where the person is about to send. */
export function ComposerBanners({ engine }: { engine: EngineStatus | null }) {
  if (!engine) return null;
  const problem = !engine.installed
    ? `${engine.name} isn't installed on this machine.`
    : engine.auth === "logged_out"
      ? `${engine.name} is signed out. Sign in from its own terminal.`
      : null;
  if (!problem) return null;
  return (
    <p className="composer-banner" role="status">
      <TriangleAlert size={14} aria-hidden />
      {problem}
    </p>
  );
}

const windowsOf = (report: EngineLimits | null): EngineLimits["windows"] => report?.windows ?? [];

/** The `/usage-limits` result, above the composer until dismissed. */
export function InlineLimits({ threadId, onClose }: { threadId: string; onClose(): void }) {
  const limits = useAsync(`thread-limits:${threadId}`, (signal) => api.threadLimits(threadId, signal));
  const windows = windowsOf(limits.data);
  return (
    <section className="composer-panel" aria-label="Usage limits">
      <header>
        <strong>Usage limits</strong>
        <IconButton label="Close usage limits" onClick={onClose}>
          <X size={14} aria-hidden />
        </IconButton>
      </header>
      {limits.status === "loading" ? <p>Checking limits...</p> : null}
      {limits.status === "error" ? <p>Couldn't read limits. {limits.error.message}</p> : null}
      {limits.status === "ready" && windows.length === 0 ? <p>No limits reported.</p> : null}
      {windows.map((window, at) => (
        <p key={at}>
          {window.label}: {Math.round(window.used_percent)}% used
          {window.resets_at ? `, resets ${relativeTime(window.resets_at).toLowerCase()}` : ""}
        </p>
      ))}
    </section>
  );
}

export function StashDrawer({
  entries,
  onRestore,
  onDelete,
  onClose,
}: {
  entries: readonly StashedPrompt[];
  onRestore(id: string): void;
  onDelete(id: string): void;
  onClose(): void;
}) {
  return (
    <section className="composer-panel" aria-label="Stashed prompts">
      <header>
        <strong>Stashed prompts</strong>
        <IconButton label="Close stash" onClick={onClose}>
          <X size={14} aria-hidden />
        </IconButton>
      </header>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <button type="button" className="stash-restore" onClick={() => onRestore(entry.id)}>
              {entry.text}
            </button>
            <IconButton label="Delete stash" onClick={() => onDelete(entry.id)}>
              <X size={14} aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
