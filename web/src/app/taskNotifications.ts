import { useEffect } from "react";
import { api } from "../api/client";
import type { TaskRun } from "../api/types";
import { navigate } from "../state/route";
import { useUi } from "../state/ui";

const FIRST_POLL_MS = 5_000;
const POLL_MS = 30_000;

/**
 * Tells you when a scheduled task's run finishes or fails, from the run history the
 * service keeps. On the first poll it reads every task's runs once, so a run already in
 * progress is announced when it ends. After that it reads a task's runs only when its last
 * run moved or one of its runs is still going, so an idle app costs one small request a poll.
 * Each run is announced once; a refused run counts as failed.
 */
export function useTaskRunNotifications() {
  const enabled = useUi((state) => state.taskRunNotifications);
  useEffect(() => {
    if (!enabled) return;
    const lastRun = new Map<string, string | null>();
    /** Every run seen, by id: still going, or over (announced or not meant to be). */
    const known = new Map<string, "active" | "over">();
    /** Runs seen going, with their task, to look at again until they end. */
    const going = new Map<string, string>();
    let primed = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();

    const announce = (run: TaskRun, name: string) => {
      const failed = run.outcome === "failed" || run.outcome === "refused";
      if (!failed && run.outcome !== "completed") return;
      const text = `Task “${name}” ${failed ? "failed" : "finished"}.`;
      const { threadNotifications, pushToast } = useUi.getState();
      const view = () => navigate({ name: "settings", section: "tasks", task: run.task_id });
      pushToast(text, failed ? "failed" : "done", { label: "View", run: view });
      // The same path thread notices take: the system notification, when the app is in the background.
      if (threadNotifications && (document.hidden || !document.hasFocus()) && "Notification" in window && Notification.permission === "granted") {
        new Notification("Orbyn", { body: text });
      }
    };
    const settle = async (taskId: string, name: string) => {
      const runs = await api.taskRuns(taskId, abort.signal);
      for (const run of runs) {
        const before = known.get(run.id);
        if (run.outcome === "queued" || run.outcome === "running") {
          known.set(run.id, "active");
          going.set(run.id, taskId);
          continue;
        }
        known.set(run.id, "over");
        going.delete(run.id);
        if (primed && before !== "over") announce(run, name);
      }
    };
    const poll = async () => {
      try {
        const tasks = await api.tasks(abort.signal);
        const watched = new Set(going.values());
        for (const task of tasks) {
          const moved = lastRun.get(task.id) !== task.last_run_at;
          lastRun.set(task.id, task.last_run_at);
          if (!primed || moved || watched.has(task.id)) await settle(task.id, task.name);
        }
        primed = true;
      } catch {
        // The next poll tries again; a service that is down has its own banner.
      }
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    timer = setTimeout(() => void poll(), FIRST_POLL_MS);
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [enabled]);
}
