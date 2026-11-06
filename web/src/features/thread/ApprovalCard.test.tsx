import { render, screen, waitFor, within } from "@testing-library/react";
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
  detail: { command: "cargo test" },
  state: "pending",
  decided_by: null,
  decided_at: null,
  created_at: "2026-10-31T10:00:00Z",
};

describe("ApprovalCard", () => {
  it("shows what it would run", () => {
    render(<ApprovalCard approval={approval} />);
    expect(screen.getByText("cargo test")).toBeInTheDocument();
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
  });

  it.each([
    ["Allow", true],
    ["Deny", false],
  ])("%s sends allow=%s", async (label, allow) => {
    const decide = vi
      .spyOn(api, "decideApproval")
      .mockResolvedValue({ ...approval, state: allow ? "allowed" : "denied" });
    render(<ApprovalCard approval={approval} />);
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(decide).toHaveBeenCalledExactlyOnceWith("a1", allow, false);
    expect(useWorkspace.getState().receipts.a1?.state).toBe(allow ? "allowed" : "denied");
    decide.mockRestore();
  });

  it("asks once before always allowing, and Cancel sends nothing", async () => {
    const decide = vi.spyOn(api, "decideApproval").mockResolvedValue({ ...approval, state: "allowed" });
    render(<ApprovalCard approval={approval} />);
    const always = screen.getByRole("button", { name: "Always allow this command" });
    expect(always).toHaveAccessibleDescription(/Allow cargo test for .* in every project from now on/);
    await userEvent.click(always);
    const dialog = await screen.findByRole("dialog", { name: "Always allow cargo test?" });
    expect(dialog).toHaveTextContent("Applies in every project.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(decide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Always allow this command" }));
    await userEvent.click(await screen.findByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(decide).toHaveBeenCalledExactlyOnceWith("a1", true, true));
    decide.mockRestore();
  });

  it("freezes options while a decision is pending", async () => {
    let finish!: (value: Approval) => void;
    const decide = vi.spyOn(api, "decideApproval").mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<ApprovalCard approval={approval} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
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
    render(<ApprovalCard approval={approval} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Already decided");
    expect(useWorkspace.getState().receipts.a1?.state).toBe("allowed");
    decide.mockRestore();
    refresh.mockRestore();
  });

  it("offers no decisions on a closed approval", () => {
    render(<ApprovalCard approval={{ ...approval, state: "expired" }} />);
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});
