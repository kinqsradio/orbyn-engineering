import { describe, expect, it } from "vitest";
import { arrangeTimeline, groupWork, type TimelineEntry } from "./timeline";
import type { ThreadItem, ToolItem } from "./projection";

const call = (n: number): ToolItem => ({ kind: "tool", key: `tool:${n}`, callId: `${n}`, seq: n,
  runId: "r", ts: "2026-11-04T00:00:00Z", name: "Read", args: JSON.stringify({ path: `file${n}` }),
  output: "", result: "ok", exitCode: 0, done: true });

describe("sentence tool row grouping", () => {
  it("groups calls in fives without losing or duplicating calls", () => {
    const calls = Array.from({ length: 12 }, (_, n) => call(n));
    const groups = groupWork(calls);
    expect(groups.map((group) => group.kind === "work" ? group.items.length : 0)).toEqual([5, 5, 2]);
    expect(groups.flatMap((group) => group.kind === "work" ? group.items : [])).toEqual(calls);
  });
  it("keeps only the newest thirty work rows live, with older work recoverable", () => {
    const calls = Array.from({ length: 43 }, (_, n) => call(n));
    const entries = arrangeTimeline(calls, {}, "r");
    const shown = entries.flatMap((entry) => entry.kind === "work" ? entry.items : []);
    expect(shown).toEqual(calls.slice(15));
    const fold = entries.find((entry) => entry.kind === "fold");
    expect(fold?.kind === "fold" ? fold.entries.flatMap((entry) => entry.kind === "work" ? entry.items : []) : []).toEqual(calls.slice(0, 15));
  });
  it("retains recent group identities when the next call arrives", () => {
    const calls = Array.from({ length: 44 }, (_, n) => call(n));
    const keys = (n: number) => arrangeTimeline(calls.slice(0, n), {}, "r").filter((entry) => entry.kind === "work").map((entry) => entry.key);
    expect(keys(44)).toEqual(keys(43));
  });
  it("preserves order and boundaries around messages and pending approvals", () => {
    const message = { kind: "message" as const, key: "m", seq: 3, runId: "r", ts: "", role: "assistant", text: "Still checking", done: true };
    const approval: ThreadItem = { kind: "approval", key: "approval", seq: 4, runId: "r", ts: "", approval: {
      id: "a", thread_id: "t", run_id: "r", kind: "command", summary: "Approve", detail: null, state: "pending", decided_by: null, decided_at: null, created_at: "",
    } };
    const items = [message, call(0), { ...message, key: "m2" }, call(1), approval, ...Array.from({ length: 42 }, (_, n) => call(n + 2))];
    const entries = arrangeTimeline(items, {}, "r");
    expect(entries).toContainEqual(message);
    expect(entries).toContainEqual(approval);
    const flatten = (list: readonly TimelineEntry[]): string[] => list.flatMap((entry): string[] => entry.kind === "fold"
      ? flatten(entry.entries) : entry.kind === "work" ? entry.items.map((item) => item.key) : entry.kind === "working" ? [] : [entry.key]);
    expect(flatten(entries)).toEqual(items.map((item) => item.key));
  });
});
