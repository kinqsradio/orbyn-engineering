import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiFailure, api } from "../../api/client";
import type { Approval } from "../../api/types";
import { useWorkspace } from "../../state/workspace";
import { ApprovalCard } from "./ApprovalCard";

const approval: Approval = {
  id: "a1",
  thread_id: "t",
  run_id: "r",
  kind: "command",
  summary: "Run tests",
  detail: { command: "cargo test", cwd: "/repo" },
  state: "pending",
  decided_by: null,
  decided_at: null,
  created_at: "2026-10-31T10:00:00Z",
};

describe("ApprovalCard", () => {
  it("shows the summary, what it touches and the engine", () => {
    render(<ApprovalCard approval={approval} engine="Claude Code" />);
    expect(screen.getByRole("heading", { name: "Run tests" })).toBeInTheDocument();
    expect(screen.getByText("cargo test")).toBeInTheDocument();
    expect(screen.getByText("/repo")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it.each([
    ["Allow", true, false],
    ["Deny", false, false],
    ["Always allow this", true, true],
  ])("%s sends allow=%s remember=%s", async (label, allow, remember) => {
    const decide = vi
      .spyOn(api, "decideApproval")
      .mockResolvedValue({ ...approval, state: allow ? "allowed" : "denied" });
    render(<ApprovalCard approval={approval} engine={null} />);
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(decide).toHaveBeenCalledExactlyOnceWith("a1", allow, remember);
    expect(useWorkspace.getState().receipts.a1?.state).toBe(allow ? "allowed" : "denied");
    decide.mockRestore();
  });

  it("freezes every option while a decision is pending", async () => {
    let finish!: (value: Approval) => void;
    const decide = vi
      .spyOn(api, "decideApproval")
      .mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<ApprovalCard approval={approval} engine={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    for (const name of ["Allow", "Deny", "Always allow this"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    finish({ ...approval, state: "allowed" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());
    decide.mockRestore();
  });

  it("says so when another decision already won", async () => {
    const decide = vi
      .spyOn(api, "decideApproval")
      .mockRejectedValue(
        new ApiFailure("already_decided", "Already allowed.", 409, { ...approval, state: "allowed" }),
      );
    const refresh = vi.spyOn(api, "pendingApprovals").mockResolvedValue([]);
    render(<ApprovalCard approval={approval} engine={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already decided");
    expect(refresh).toHaveBeenCalled();
    expect(useWorkspace.getState().receipts.a1?.state).toBe("allowed");
    decide.mockRestore();
    refresh.mockRestore();
  });

  it("does not offer decisions on a closed approval", () => {
    render(<ApprovalCard approval={{ ...approval, state: "expired" }} engine={null} />);
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});
