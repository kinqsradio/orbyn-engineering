import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { applyEvents, emptyLog, type ToolItem } from "./projection";
import { WorkflowControls } from "./WorkflowControls";
import type { AgUiEvent, WireThreadEvent } from "../../api/types";

const THREAD = "t-workflow";

const tool = (workflow?: ToolItem["workflow"]): ToolItem => ({
  key: "tool:wf",
  seq: 1,
  ts: "2026-11-06T00:00:00Z",
  runId: "r1",
  kind: "tool",
  callId: "wf",
  name: "Workflow",
  args: "{}",
  output: "",
  result: "Workflow launched in background.",
  done: true,
  exitCode: null,
  ...(workflow ? { workflow } : {}),
});

function stubFetch(answer: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return answer(url, init);
    }),
  );
  return calls;
}

describe("workflow controls", () => {
  it("shows nothing for an ordinary tool call", () => {
    const { container } = render(<WorkflowControls item={tool()} threadId={THREAD} live />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the script the service reads", async () => {
    const user = userEvent.setup();
    const calls = stubFetch(() =>
      new Response(JSON.stringify({ path: "/home/me/.claude/projects/p/flow.js", contents: "await agent('look')", truncated: false })),
    );
    render(<WorkflowControls item={tool({ state: "completed", name: "probe" })} threadId={THREAD} live={false} />);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop workflow" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "View script" }));
    expect(await screen.findByText("/home/me/.claude/projects/p/flow.js")).toBeTruthy();
    expect(calls).toEqual([{ url: `/api/threads/${THREAD}/workflows/wf/script`, method: "GET" }]);
  });

  it("stops a running workflow and shows a refusal", async () => {
    const user = userEvent.setup();
    const calls = stubFetch(() =>
      new Response(JSON.stringify({ code: "invalid", message: "This workflow is no longer running." }), { status: 400 }),
    );
    render(<WorkflowControls item={tool({ state: "running", name: "probe" })} threadId={THREAD} live />);
    await user.click(screen.getByRole("button", { name: "Stop workflow" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no longer running"));
    expect(calls).toEqual([{ url: `/api/threads/${THREAD}/workflows/wf/stop`, method: "POST" }]);
  });
});

describe("workflow events", () => {
  const wire = (seq: number, event: AgUiEvent): WireThreadEvent => ({ seq, thread_id: THREAD, run_id: "r1", ts: "", event });

  it("fold onto the call that launched the workflow", () => {
    const events = [
      wire(1, { type: "TOOL_CALL_START", toolCallId: "wf", toolCallName: "Workflow" }),
      wire(2, { type: "CUSTOM", name: "workflow.state", value: { toolCallId: "wf", name: "probe", state: "running" } }),
      wire(3, { type: "CUSTOM", name: "workflow.stop_failed", value: { toolCallId: "wf", message: "Claude Code did not stop the workflow." } }),
      wire(4, { type: "CUSTOM", name: "workflow.state", value: { toolCallId: "wf", state: "stopped" } }),
      wire(5, { type: "CUSTOM", name: "workflow.state", value: { toolCallId: "wf", state: "bogus" } }),
    ];
    const item = applyEvents(THREAD, emptyLog, events).items[0];
    expect(item?.kind === "tool" ? item.workflow : null).toEqual({ state: "stopped", name: "probe" });
    const refused = applyEvents(THREAD, emptyLog, events.slice(0, 3)).items[0];
    expect(refused?.kind === "tool" ? refused.workflow?.stopError : null).toBe("Claude Code did not stop the workflow.");
  });
});
