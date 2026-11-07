import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { TaskRun } from "../api/types";
import * as fixtures from "../../mock/fixtures";
import { useUi } from "../state/ui";
import { useTaskRunNotifications } from "./taskNotifications";

function Probe() {
  useTaskRunNotifications();
  return null;
}
type Task = ReturnType<typeof fixtures.scheduledTasks>[number];
const [base] = fixtures.scheduledTasks() as [Task];
const task = (lastRun: string | null): Task => ({ ...base, last_run_at: lastRun });
const [, , finished] = fixtures.taskRuns("task-review") as [TaskRun, TaskRun, TaskRun];
const run = (id: string, outcome: string): TaskRun => ({ ...finished, id, task_id: base.id, outcome });

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ toasts: [], taskRunNotifications: true });
  shown = [];
  const seen = new Set<number>();
  stopListening = useUi.subscribe((state) => { for (const toast of state.toasts) if (!seen.has(toast.id)) { seen.add(toast.id); shown.push(toast.text); } });
});
afterEach(() => {
  stopListening();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const poll = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** Every toast ever shown, since a toast fades on its own. */
let shown: string[] = [];
let stopListening: () => void = () => {};
const texts = () => shown;

it("says when a task's run finishes or fails, once, and not for what was already there", async () => {
  const list = vi.spyOn(api, "tasks").mockResolvedValue([task("2026-10-31T08:00:00Z")]);
  const history = vi.spyOn(api, "taskRuns").mockResolvedValue([run("old", "completed")]);
  render(<Probe />);
  await poll(5_000);
  expect(texts()).toEqual([]);

  list.mockResolvedValue([task("2026-10-31T09:00:00Z")]);
  history.mockResolvedValue([run("r2", "completed"), run("old", "completed")]);
  await poll(30_000);
  expect(texts()).toEqual(["Task “Daily review” finished."]);

  await poll(30_000);
  expect(history).toHaveBeenCalledTimes(2);
  expect(texts()).toHaveLength(1);

  list.mockResolvedValue([task("2026-10-31T09:30:00Z")]);
  history.mockResolvedValue([run("r3", "failed"), run("r2", "completed")]);
  await poll(30_000);
  expect(texts()).toEqual(["Task “Daily review” finished.", "Task “Daily review” failed."]);
});

it("announces a run that was going when the app opened, once it ends, and a refused run as failed", async () => {
  vi.spyOn(api, "tasks").mockResolvedValue([task("2026-10-31T08:00:00Z")]);
  const history = vi.spyOn(api, "taskRuns").mockResolvedValue([run("going", "running")]);
  render(<Probe />);
  await poll(5_000);
  await poll(30_000);
  expect(texts()).toEqual([]);
  history.mockResolvedValue([run("going", "refused")]);
  await poll(30_000);
  expect(texts()).toEqual(["Task “Daily review” failed."]);
  await poll(30_000);
  expect(texts()).toHaveLength(1);
});

it("re-checks every run that was going, so an older run ending after a newer one is announced", async () => {
  const list = vi.spyOn(api, "tasks").mockResolvedValue([task("2026-10-31T08:00:00Z")]);
  const history = vi.spyOn(api, "taskRuns").mockResolvedValue([run("newer", "running"), run("older", "running")]);
  render(<Probe />);
  await poll(5_000);
  list.mockResolvedValue([task("2026-10-31T09:00:00Z")]);
  history.mockResolvedValue([run("newer", "completed"), run("older", "running")]);
  await poll(30_000);
  expect(texts()).toEqual(["Task “Daily review” finished."]);
  history.mockResolvedValue([run("newer", "completed"), run("older", "failed")]);
  await poll(30_000);
  expect(texts()).toEqual(["Task “Daily review” finished.", "Task “Daily review” failed."]);
});

it("asks nothing when the setting is off", async () => {
  useUi.setState({ taskRunNotifications: false });
  const list = vi.spyOn(api, "tasks").mockResolvedValue([task("2026-10-31T08:00:00Z")]);
  render(<Probe />);
  await poll(60_000);
  expect(list).not.toHaveBeenCalled();
});

it("offers View, which opens the task, and sends a system notice only when the app is in the background", async () => {
  const list = vi.spyOn(api, "tasks").mockResolvedValue([task("2026-10-31T08:00:00Z")]);
  const history = vi.spyOn(api, "taskRuns").mockResolvedValue([run("old", "completed")]);
  const sent: { title: string; body?: string }[] = [];
  class Sent { constructor(title: string, options?: { body?: string }) { sent.push({ title, body: options?.body }); } static permission = "granted"; }
  vi.stubGlobal("Notification", Sent);
  useUi.setState({ threadNotifications: true });
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  render(<Probe />);
  await poll(5_000);
  history.mockResolvedValue([run("r2", "failed")]);
  list.mockResolvedValue([task("2026-10-31T09:00:00Z")]);
  await poll(30_000);
  const [toast] = useUi.getState().toasts;
  expect(toast?.action?.label).toBe("View");
  expect(sent).toEqual([]);
  toast?.action?.run();
  expect(window.location.hash).toBe(`#/settings/tasks?task=${base.id}`);

  focus.mockReturnValue(false);
  history.mockResolvedValue([run("r3", "failed")]);
  list.mockResolvedValue([task("2026-10-31T10:00:00Z")]);
  await poll(30_000);
  expect(sent).toEqual([{ title: "Orbyn", body: "Task “Daily review” failed." }]);
  vi.unstubAllGlobals();
});
