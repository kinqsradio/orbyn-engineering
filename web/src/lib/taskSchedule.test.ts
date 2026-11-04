import { expect, it } from "vitest";
import type { ScheduledTask } from "../api/types";
import { scheduleLabel, scheduleLine, taskTone } from "./taskSchedule";

const now = Date.UTC(2026, 10, 4, 9, 0, 0);

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "task-1",
  project_id: "p-app",
  thread_id: "t-approval",
  name: "Daily review",
  prompt: "Review the open changes.",
  engine: "claude",
  schedule: {
    kind: "interval",
    every_minutes: 60,
    time: null,
    weekdays: [],
    utc_offset_minutes: 0,
    only_on_success: false,
  },
  enabled: true,
  signature: null,
  has_secret: false,
  filters: [],
  dedupe: null,
  max_age_seconds: null,
  timestamp_path: null,
  next_run_at: null,
  last_run_at: null,
  last_status: "never",
  created_at: "",
  ...over,
});

it("names each schedule kind in words", () => {
  expect(scheduleLabel(task().schedule)).toBe("Every 60 min");
  expect(scheduleLabel({ ...task().schedule, kind: "fixed_time", time: "09:00", weekdays: [] })).toBe("Daily at 09:00");
  expect(scheduleLabel({ ...task().schedule, kind: "fixed_time", time: "09:00", weekdays: [1, 2, 3, 4, 5] })).toBe("Weekdays at 09:00");
  expect(scheduleLabel({ ...task().schedule, kind: "fixed_time", time: "09:00", weekdays: [1, 3] })).toBe("Mon, Wed at 09:00");
  expect(scheduleLabel({ ...task().schedule, kind: "webhook" })).toBe("On webhook");
  expect(scheduleLabel({ ...task().schedule, kind: "after_thread", only_on_success: false })).toBe("After a thread");
  expect(scheduleLabel({ ...task().schedule, kind: "after_thread", only_on_success: true })).toBe("After a thread succeeds");
});

it("maps the stored status to the row tone", () => {
  expect(taskTone({ last_status: "never" })).toBe("idle");
  expect(taskTone({ last_status: "started" })).toBe("ok");
  expect(taskTone({ last_status: "The engine exited with status 1." })).toBe("fail");
});

it("adds the next run, pause state or failure to the schedule", () => {
  expect(scheduleLine(task({ next_run_at: new Date(now + 10 * 60_000).toISOString() }), now)).toBe("Every 60 min · next in 10 min");
  expect(scheduleLine(task({ enabled: false }), now)).toBe("Every 60 min · paused");
  expect(scheduleLine(task({ last_status: "The engine exited with status 1." }), now)).toBe(
    "Every 60 min · The engine exited with status 1.",
  );
});

it("marks a next run that is already due without claiming it is in the future", () => {
  expect(scheduleLine(task({ next_run_at: new Date(now - 5 * 60_000).toISOString() }), now)).toBe("Every 60 min · overdue");
});

it("treats the minute around the due time as due, not as next or overdue", () => {
  const at = (offset: number) => new Date(now + offset).toISOString();
  expect(scheduleLine(task({ next_run_at: at(30_000) }), now)).toBe("Every 60 min · due");
  expect(scheduleLine(task({ next_run_at: at(0) }), now)).toBe("Every 60 min · due");
  expect(scheduleLine(task({ next_run_at: at(-30_000) }), now)).toBe("Every 60 min · due");
  expect(scheduleLine(task({ next_run_at: at(-61_000) }), now)).toBe("Every 60 min · overdue");
  expect(scheduleLine(task({ next_run_at: at(60_000) }), now)).toBe("Every 60 min · next in 1 min");
});
