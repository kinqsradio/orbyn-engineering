import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { LedgerPin } from "./LedgerPin";

const approval = (id: string, threadId: string, state: Approval["state"] = "pending"): Approval =>
  ({ id, thread_id: threadId, run_id: "r1", kind: "tool", summary: `Run ${id}?`, detail: {}, state, decided_by: null, decided_at: null, created_at: "" }) as Approval;

const seed = (data: Approval[]) => useWorkspace.setState({ approvals: { loading: false, error: null, data } });

describe("LedgerPin", () => {
  afterEach(() => useUi.getState().setPrefs({ workspaceLayout: "console" }));

  it("pins the thread's waiting decision in the Ledger layout", () => {
    useUi.getState().setPrefs({ workspaceLayout: "ledger" });
    seed([approval("a1", "t1"), approval("a2", "t1"), approval("x", "t2"), approval("done", "t1", "allowed")]);
    render(<LedgerPin threadId="t1" />);
    const pin = screen.getByRole("status");
    expect(pin).toHaveTextContent("Needs you");
    expect(pin).toHaveTextContent("2 decisions waiting. Run a1?");
    expect(screen.getByRole("button", { name: "Show" })).toBeInTheDocument();
  });

  it("stays out of the other layouts and of threads with nothing waiting", () => {
    seed([approval("a1", "t1")]);
    const { container, rerender } = render(<LedgerPin threadId="t1" />);
    expect(container).toBeEmptyDOMElement();
    useUi.getState().setPrefs({ workspaceLayout: "ledger" });
    rerender(<LedgerPin threadId="t9" />);
    expect(container).toBeEmptyDOMElement();
  });
});
