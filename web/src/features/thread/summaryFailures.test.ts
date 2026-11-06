import { expect, it } from "vitest";
import type { ToolItem } from "../../state/thread/projection";
import { summarizeWork } from "./toolTrace";
import { arrangeTimeline } from "./timeline";

const tool = (name: string, exitCode: number | null, done = true): ToolItem => ({ kind: "tool", seq: 1, runId: "r", ts: "", key: name,
  callId: name, name, args: JSON.stringify({ paths: ["a", "b"] }), result: done ? "result" : null, output: "", done, exitCode });

it("counts only successful completed actions and reports failures separately", () => {
  expect(summarizeWork([tool("Read", 0), tool("Write", 1), tool("Bash", null, false)])).toMatchObject({
    summary: "Read 1 file; 1 tool call failed; 1 tool call without a result", failed: true,
  });
});
it("does not invent a tool outcome after its failed turn ends without a result", () => {
  const unresolved = { ...tool("Write", null), result: null };
  const entries = arrangeTimeline([unresolved], { r: { startedAt: "2026-11-04T00:00:00Z", endedAt: "2026-11-04T00:00:01Z", outcome: "failed" } }, null);
  expect(entries[0]).toMatchObject({ kind: "fold", label: "1 tool call without a result · 1s" });
});
it("never describes a failed edit as changed files", () => {
  expect(summarizeWork([tool("Write", 1)])).toMatchObject({ summary: "1 tool call failed", failed: true });
});
it("does not turn a result with unknown outcome into completed work", () => {
  expect(summarizeWork([tool("Write", null)]).summary).toBe("1 tool call finished without a reported outcome");
});
it("counts a supported protocol success and excludes a protocol failure without inventing exit codes", () => {
  expect(summarizeWork([{ ...tool("Read", null), outcome: "success" }, { ...tool("Write", null), outcome: "failure" }])).toMatchObject({
    summary: "Read 1 file; 1 tool call failed", failed: true,
  });
});
it("uses the same honest action summary for a finished turn", () => {
  const entries = arrangeTimeline([tool("Read", 0), tool("Write", 1)], {}, null);
  expect(entries[0]).toMatchObject({ kind: "fold", label: "Read 1 file; 1 tool call failed" });
});
