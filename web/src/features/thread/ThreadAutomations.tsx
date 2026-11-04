import { AlertTriangle, CalendarClock, Pencil, Play, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { request } from "../../api/client";
import type { ScheduledTask } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useNow } from "../../lib/useNow";
import { scheduleLine, taskTone, type TaskTone } from "../../lib/taskSchedule";
import { navigate, useRoute } from "../../state/route";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";

const q = encodeURIComponent;

/** Tasks bound to this thread, with the same run, pause and edit controls as Settings. */
export function ThreadAutomations({ threadId }: { threadId: string }) {
  const tasks = useAsync(`details-tasks:${threadId}`, (signal) =>
    request<ScheduledTask[]>("GET", "/api/tasks", undefined, signal),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const pushToast = useUi((state) => state.pushToast);
  const route = useRoute();
  const inSettings = route.name === "settings";
  const wasInSettings = useRef(inSettings);
  const bound = (tasks.data ?? []).filter((task) => task.thread_id === threadId);
  const now = useNow(bound.some((task) => task.enabled && task.next_run_at !== null), 30_000);
  const reload = tasks.reload;
  const dueAt = bound.reduce(
    (earliest, task) =>
      task.enabled && task.next_run_at ? Math.min(earliest, new Date(task.next_run_at).getTime()) : earliest,
    Number.POSITIVE_INFINITY,
  );
  const refreshedAt = useRef(Date.now());

  useEffect(() => {
    if (wasInSettings.current && !inSettings) void reload();
    wasInSettings.current = inSettings;
  }, [inSettings, reload]);

  // A fired task gets a new next_run_at in the service. Re-read once the old one
  // passes so the row cannot stay "overdue" while the task keeps running.
  useEffect(() => {
    if (!Number.isFinite(dueAt) || now < dueAt + 5_000 || now - refreshedAt.current < 60_000) return;
    refreshedAt.current = now;
    void reload();
  }, [dueAt, now, reload]);

  if (tasks.status === "loading") return null;
  if (tasks.status === "error" && bound.length === 0) {
    return (
      <div className="details-section">
        <div className="details-head">
          <span>Automations</span>
          <ManageButton />
        </div>
        <div className="detail-row detail-row-static" title={tasks.error.message}>
          <AlertTriangle size={16} aria-hidden />
          <span>Couldn't load automations</span>
          <Button small tone="quiet" onClick={tasks.reload}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (bound.length === 0) return null;

  const toggle = async (task: ScheduledTask, enabled: boolean) => {
    setBusy(task.id);
    setPending((current) => ({ ...current, [task.id]: enabled }));
    try {
      await request("POST", `/api/tasks/${q(task.id)}/enabled`, { enabled });
      // Keep the optimistic value until the reloaded row carries it; otherwise
      // the switch snaps back to the old state while the GET is in flight.
      await reload();
    } catch (failure) {
      pushToast(`Couldn't ${enabled ? "resume" : "pause"} ${task.name}. ${toFailure(failure).message}`);
    } finally {
      setBusy(null);
      setPending((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  };

  const run = async (task: ScheduledTask) => {
    setBusy(task.id);
    try {
      await request("POST", `/api/tasks/${q(task.id)}/run`);
    } catch (failure) {
      pushToast(`Couldn't run ${task.name}. ${toFailure(failure).message}`);
    } finally {
      // A failed run records its reason in last_status, so refresh in both cases.
      await reload();
      setBusy(null);
    }
  };

  return (
    <div className="details-section">
      <div className="details-head">
        <span>Automations</span>
        <ManageButton />
      </div>
      <ul className="detail-automations" aria-label="Automations">
        {bound.map((task) => {
          const tone = taskTone(task);
          const line = scheduleLine(task, now);
          const enabled = pending[task.id] ?? task.enabled;
          return (
            <li key={task.id} className="detail-row detail-row-static">
              <div className="detail-automation-icon">
                <CalendarClock size={16} aria-hidden />
                <span className={`detail-dot detail-dot-${tone}`} role="img" aria-label={toneLabel(tone)} />
              </div>
              <span title={`${task.name} — ${line}`}>
                <span className="detail-automation-name">{task.name}</span>
                <span className={`detail-automation-when${tone === "fail" ? " is-failed" : ""}`}>{line}</span>
              </span>
              <IconButton
                label={`Edit ${task.name}`}
                disabled={busy !== null}
                onClick={() => navigate({ name: "settings", section: "tasks", task: task.id })}
              >
                <Pencil size={14} aria-hidden />
              </IconButton>
              {task.schedule.kind === "webhook" ? null : (
                <IconButton label={`Run ${task.name} now`} disabled={busy !== null} onClick={() => void run(task)}>
                  <Play size={14} aria-hidden />
                </IconButton>
              )}
              <input
                type="checkbox"
                role="switch"
                aria-label={`Enable ${task.name}`}
                checked={enabled}
                disabled={busy !== null}
                onChange={(event) => void toggle(task, event.target.checked)}
              />
            </li>
          );
        })}
      </ul>
      {tasks.status === "error" ? (
        <p className="detail-automation-error" role="alert">
          Couldn't refresh automations. {tasks.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** The dot's meaning, for readers who cannot see its colour. */
function toneLabel(tone: TaskTone): string {
  if (tone === "idle") return "Not run yet";
  if (tone === "ok") return "Last run started";
  return "Last run failed";
}

function ManageButton() {
  return (
    <IconButton label="Manage scheduled tasks" onClick={() => navigate({ name: "settings", section: "tasks" })}>
      <Settings2 size={14} aria-hidden />
    </IconButton>
  );
}
