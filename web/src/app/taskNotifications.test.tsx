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
const runs = (outcome: string): TaskRun[] => [{ ...finished, outcome }];

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ toasts: [], taskRunNotifications: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const poll = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it("says when a task's run finishes or fails, once, and not for what was already there", async () => {
  const list = vi.spyOn(api, "tasks").mockResolvedValue([task("2026-10-31T08:00:00Z")]);
  const history = vi.spyOn(api, "taskRuns");
  render(<Probe />);
  await poll(5_000);
  expect(history).not.toHaveBeenCalled();

  list.mockResolvedValue([task("2026-10-31T09:00:00Z")]);
  history.mockResolvedValue(runs("completed"));
  await poll(30_000);
  expect(useUi.getState().toasts.map((toast) => toast.text)).toEqual(["Task “Daily review” finished."]);

  await poll(30_000);
  expect(history).toHaveBeenCalledTimes(1);

  list.mockResolvedValue([task("2026-10-31T09:30:00Z")]);
  history.mockResolvedValue(runs("failed"));
  await poll(30_000);
  expect(useUi.getState().toasts.map((toast) => toast.text)).toEqual(["Task “Daily review” failed."]);
});

it("waits for a run that is still going and asks nothing when the setting is off", async () => {
  const list = vi.spyOn(api, "tasks").mockResolvedValue([task("2026-10-31T08:00:00Z")]);
  const history = vi.spyOn(api, "taskRuns").mockResolvedValue(runs("running"));
  const view = render(<Probe />);
  await poll(5_000);
  list.mockResolvedValue([task("2026-10-31T09:00:00Z")]);
  await poll(30_000);
  expect(useUi.getState().toasts).toHaveLength(0);
  history.mockResolvedValue(runs("completed"));
  await poll(30_000);
  expect(useUi.getState().toasts.map((toast) => toast.text)).toEqual(["Task “Daily review” finished."]);

  view.unmount();
  useUi.setState({ toasts: [], taskRunNotifications: false });
  list.mockClear();
  render(<Probe />);
  await poll(60_000);
  expect(list).not.toHaveBeenCalled();
});

it("offers View, which opens the task, and sends a system notice only when the app is in the background", async () => {
  const list = vi.spyOn(api, "tasks").mockResolvedValue([task("2026-10-31T08:00:00Z")]);
  vi.spyOn(api, "taskRuns").mockResolvedValue(runs("failed"));
  const sent: { title: string; body?: string }[] = [];
  class Sent { constructor(title: string, options?: { body?: string }) { sent.push({ title, body: options?.body }); } static permission = "granted"; }
  vi.stubGlobal("Notification", Sent);
  useUi.setState({ threadNotifications: true });
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  render(<Probe />);
  await poll(5_000);
  list.mockResolvedValue([task("2026-10-31T09:00:00Z")]);
  await poll(30_000);
  const [toast] = useUi.getState().toasts;
  expect(toast?.action?.label).toBe("View");
  expect(sent).toEqual([]);
  toast?.action?.run();
  expect(window.location.hash).toBe(`#/settings/tasks?task=${base.id}`);

  focus.mockReturnValue(false);
  list.mockResolvedValue([task("2026-10-31T10:00:00Z")]);
  await poll(30_000);
  expect(sent).toEqual([{ title: "Orbyn", body: "Task “Daily review” failed." }]);
  vi.unstubAllGlobals();
});
