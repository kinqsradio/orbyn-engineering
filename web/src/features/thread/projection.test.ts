import { describe, expect, it } from "vitest";
import type { AgUiEvent, WireThreadEvent } from "../../api/types";
import { applyEvents, emptyLog } from "./projection";

const ev = (seq: number, event: AgUiEvent): WireThreadEvent => ({
  seq,
  thread_id: "t",
  run_id: "r",
  ts: "2026-10-31T10:00:00Z",
  event,
});

const text = (seq: number, delta: string) =>
  ev(seq, { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta });
const start = (seq: number) =>
  ev(seq, { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" });

describe("applyEvents", () => {
  it("accumulates streamed text", () => {
    const log = applyEvents("t", emptyLog, [start(1), text(2, "Hel"), text(3, "lo")]);
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ kind: "message", text: "Hello", done: false });
    expect(log.lastSeq).toBe(3);
  });

  it("drops replayed seqs and returns the same log when nothing is new", () => {
    const first = applyEvents("t", emptyLog, [start(1), text(2, "a")]);
    const replay = applyEvents("t", first, [start(1), text(2, "a")]);
    expect(replay).toBe(first);
    const more = applyEvents("t", first, [text(2, "a"), text(3, "b")]);
    expect(more.items[0]).toMatchObject({ text: "ab" });
  });

  it("orders an out-of-order batch by seq", () => {
    const log = applyEvents("t", emptyLog, [text(3, "b"), start(1), text(2, "a")]);
    expect(log.items[0]).toMatchObject({ text: "ab" });
  });

  it("rebuilds when a late seq arrives behind the head", () => {
    const head = applyEvents("t", emptyLog, [start(1), text(3, "b")]);
    const late = applyEvents("t", head, [text(2, "a")]);
    expect(late.items[0]).toMatchObject({ text: "ab" });
    expect(late.lastSeq).toBe(3);
  });

  it("keeps a reused id apart per run", () => {
    const inRun = (seq: number, runId: string, event: AgUiEvent): WireThreadEvent => ({ ...ev(seq, event), run_id: runId });
    const turn = (at: number, runId: string, delta: string) => [
      inRun(at, runId, { type: "TEXT_MESSAGE_START", messageId: "msg1", role: "assistant" }),
      inRun(at + 1, runId, { type: "TEXT_MESSAGE_CONTENT", messageId: "msg1", delta }),
      inRun(at + 2, runId, { type: "TEXT_MESSAGE_END", messageId: "msg1" }),
      inRun(at + 3, runId, { type: "REASONING_MESSAGE_START", messageId: "rs1", role: "reasoning" }),
      inRun(at + 4, runId, { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Read" }),
    ];
    const log = applyEvents("t", emptyLog, [...turn(1, "a", "first"), ...turn(6, "b", "second")]);
    expect(log.items.map((item) => [item.runId, item.kind])).toEqual([
      ["a", "message"],
      ["a", "reasoning"],
      ["a", "tool"],
      ["b", "message"],
      ["b", "reasoning"],
      ["b", "tool"],
    ]);
    expect(log.items[0]).toMatchObject({ text: "first" });
    expect(log.items[3]).toMatchObject({ text: "second" });
  });

  it("joins tool arguments and results", () => {
    const log = applyEvents("t", emptyLog, [
      ev(1, { type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "Read" }),
      ev(2, { type: "TOOL_CALL_ARGS", toolCallId: "c", delta: '{"a"' }),
      ev(3, { type: "TOOL_CALL_ARGS", toolCallId: "c", delta: ":1}" }),
      ev(4, { type: "TOOL_CALL_END", toolCallId: "c" }),
      ev(5, {
        type: "TOOL_CALL_RESULT",
        messageId: "x",
        toolCallId: "c",
        content: "ok",
        role: "tool",
      }),
    ]);
    expect(log.items[0]).toMatchObject({ kind: "tool", args: '{"a":1}', result: "ok", done: true });
  });

  it("accumulates streamed tool output until the result arrives", () => {
    const log = applyEvents("t", emptyLog, [
      ev(1, { type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "Bash" }),
      ev(2, { type: "CUSTOM", name: "tool.output", value: { toolCallId: "c", delta: "line 1\n" } }),
      ev(3, { type: "CUSTOM", name: "tool.output", value: { toolCallId: "c", delta: "line 2" } }),
    ]);
    expect(log.items[0]).toMatchObject({ output: "line 1\nline 2", result: null, done: false });
  });

  it("replaces an approval snapshot in place, keeping its position", () => {
    const snapshot = (seq: number, state: string) =>
      ev(seq, {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "a",
        activityType: "approval",
        content: { id: "ap1", summary: "Run tests", state },
        replace: true,
      });
    const log = applyEvents("t", emptyLog, [
      snapshot(1, "pending"),
      start(2),
      snapshot(3, "allowed"),
    ]);
    expect(log.items[0]).toMatchObject({ kind: "approval" });
    expect(log.items[0]?.kind === "approval" && log.items[0].approval.state).toBe("allowed");
    expect(log.items).toHaveLength(2);
  });

  it("keeps the existing activity when replace is false", () => {
    const log = applyEvents("t", emptyLog, [
      ev(1, {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "p",
        activityType: "plan",
        content: { steps: ["One"] },
        replace: null,
      }),
      ev(2, {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "p",
        activityType: "plan",
        content: { steps: ["Two"] },
        replace: false,
      }),
    ]);
    expect(log.items[0]).toMatchObject({ steps: [{ text: "One" }] });
  });

  it("shows run errors and cancellation as notices", () => {
    const log = applyEvents("t", emptyLog, [
      ev(1, { type: "RUN_ERROR", message: "Engine exited", code: "engine_exit" }),
      ev(2, {
        type: "RUN_FINISHED",
        threadId: "t",
        runId: "r",
        outcome: { type: "cancelled" },
      }),
    ]);
    expect(log.items.map((item) => item.kind === "notice" && item.text)).toEqual([
      "Engine exited",
      "Run cancelled.",
    ]);
    expect(log.timeline.at(0)).toMatchObject({ tone: "error" });
  });

  it("keeps a reused activity id separate per run", () => {
    const plan = (seq: number, run: string, step: string): WireThreadEvent => ({
      ...ev(seq, {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "plan",
        activityType: "plan",
        content: { steps: [step] },
        replace: true,
      }),
      run_id: run,
    });
    const log = applyEvents("t", emptyLog, [plan(1, "r1", "A"), plan(2, "r1", "B"), plan(3, "r2", "C")]);
    expect(log.items).toHaveLength(2);
    expect(log.items[0]).toMatchObject({ steps: [{ text: "B" }] });
  });

  it("shows the unmanaged notice from a terminal run", () => {
    const log = applyEvents("t", emptyLog, [
      ev(1, {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "unmanaged",
        activityType: "unmanaged",
        content: { message: "Orbyn cannot review its actions." },
        replace: true,
      }),
    ]);
    expect(log.items[0]).toMatchObject({ kind: "notice", text: "Orbyn cannot review its actions." });
  });

  it("ignores content for a message that never started", () => {
    const log = applyEvents("t", emptyLog, [text(1, "orphan")]);
    expect(log.items).toHaveLength(0);
    expect(log.lastSeq).toBe(1);
  });

  it("renders an unknown activity type without crashing", () => {
    const log = applyEvents("t", emptyLog, [
      ev(1, {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "x",
        activityType: "search",
        content: { q: "a" },
        replace: true,
      }),
    ]);
    expect(log.items[0]).toMatchObject({ kind: "activity", activityType: "search" });
  });
});
