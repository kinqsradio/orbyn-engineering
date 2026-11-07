import { useEffect } from "react";
import { api } from "../api/client";
import { navigate } from "../state/route";
import { useUi } from "../state/ui";

const FIRST_POLL_MS = 5_000;
const POLL_MS = 30_000;

/**
 * Tells you when a scheduled task's run finishes or fails, from the run history the
 * service keeps. It asks the task list while the setting is on, and looks at a task's
 * runs only when its last run moved, so an idle app costs one small request a poll.
 */
export function useTaskRunNotifications() {
  const enabled = useUi((state) => state.taskRunNotifications);
  useEffect(() => {
    if (!enabled) return;
    const lastRun = new Map<string, string | null>();
    /** Runs seen starting that have not ended yet, by task, to look at again. */
    const waiting = new Map<string, string>();
    let primed = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();

    const settle = async (taskId: string, name: string) => {
      const [newest] = await api.taskRuns(taskId, abort.signal);
      if (!newest) return;
      if (newest.outcome === "queued" || newest.outcome === "running") {
        waiting.set(taskId, newest.id);
        return;
      }
      waiting.delete(taskId);
      if (newest.outcome !== "completed" && newest.outcome !== "failed") return;
      const text = `Task “${name}” ${newest.outcome === "completed" ? "finished" : "failed"}.`;
      const { threadNotifications, pushToast } = useUi.getState();
      const view = () => navigate({ name: "settings", section: "tasks", task: taskId });
      pushToast(text, newest.outcome === "completed" ? "done" : "failed", { label: "View", run: view });
      // The same path thread notices take: the system notification, when the app is in the background.
      if (threadNotifications && (document.hidden || !document.hasFocus()) && "Notification" in window && Notification.permission === "granted") {
        new Notification("Orbyn", { body: text });
      }
    };
    const poll = async () => {
      try {
        const tasks = await api.tasks(abort.signal);
        for (const task of tasks) {
          const moved = lastRun.get(task.id) !== task.last_run_at;
          lastRun.set(task.id, task.last_run_at);
          if (primed && (moved || waiting.has(task.id))) await settle(task.id, task.name);
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
