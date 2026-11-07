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
  expect(useUi.getState().toasts.map((toast) => toast.text)).toEqual(["Daily review finished"]);

  await poll(30_000);
  expect(history).toHaveBeenCalledTimes(1);

  list.mockResolvedValue([task("2026-10-31T09:30:00Z")]);
  history.mockResolvedValue(runs("failed"));
  await poll(30_000);
  expect(useUi.getState().toasts.map((toast) => toast.text)).toEqual(["Daily review failed"]);
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
  expect(useUi.getState().toasts.map((toast) => toast.text)).toEqual(["Daily review finished"]);

  view.unmount();
  useUi.setState({ toasts: [], taskRunNotifications: false });
  list.mockClear();
  render(<Probe />);
  await poll(60_000);
  expect(list).not.toHaveBeenCalled();
});
