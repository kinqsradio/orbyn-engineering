import { expect, it } from "vitest";
import { applyEvents, emptyLog } from "../../state/thread/projection";
import type { AgUiEvent, WireThreadEvent } from "../../api/types";
import { summarizeWork } from "./toolTrace";

const wire = (seq: number, event: AgUiEvent): WireThreadEvent => ({ seq, thread_id: "t", run_id: "r", ts: "", event });

it.each([null, 0])("replays explicit failure without losing it to exit code %s", (exitCode) => {
  const events = [
    wire(1, { type: "TOOL_CALL_START", toolCallId: "write", toolCallName: "Write" }),
    wire(2, { type: "TOOL_CALL_ARGS", toolCallId: "write", delta: '{"path":"a"}' }),
    wire(3, { type: "TOOL_CALL_RESULT", toolCallId: "write", messageId: "result", content: "denied", role: "tool" }),
    wire(4, { type: "CUSTOM", name: "tool.outcome", value: { toolCallId: "write", outcome: "failure" } }),
    ...(exitCode === null ? [] : [wire(5, { type: "CUSTOM", name: "tool.finished", value: { toolCallId: "write", exitCode } })]),
    wire(6, { type: "CUSTOM", name: "tool.outcome", value: { toolCallId: "write", outcome: "unknown" } }),
  ];
  const log = applyEvents("t", emptyLog, events);
  const item = log.items[0];
  expect(item).toMatchObject({ kind: "tool", outcome: "failure", exitCode });
  if (item?.kind !== "tool") throw new Error("Missing tool");
  expect(summarizeWork([item]).summary).toBe("1 tool call failed");
  expect(applyEvents("t", log, events)).toBe(log);
});
