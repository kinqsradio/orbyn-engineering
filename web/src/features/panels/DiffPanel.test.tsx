import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { DiffPanel } from "./DiffPanel";
afterEach(() => vi.restoreAllMocks());
it("shows a historical turn diff without exposing a per-file restore action", async () => {
  const user = userEvent.setup();
  const diff = vi.spyOn(api, "diff").mockResolvedValue([{ path: "notes.txt", status: "modified", additions: 1,
    deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new\n" }]);
  vi.spyOn(api, "checkpoints").mockResolvedValue([{ run_id: "r", start: "start", end: "end", created_at: "" }]);
  const changes = vi.spyOn(api, "runChanges").mockResolvedValue({ run_id: "r", paths: ["notes.txt"], truncated: false,
    files: [{ path: "notes.txt", status: "modified", restorable: true }] });
  render(<DiffPanel threadId="t" />);
  await screen.findByRole("button", { name: "Copy path notes.txt" });
  await user.click(screen.getByRole("radio", { name: "Turn" }));
  await waitFor(() => expect(diff).toHaveBeenCalledWith("t", expect.any(AbortSignal), "turn&run=r"));
  await screen.findByRole("button", { name: "Copy path notes.txt" });
  expect(screen.queryByRole("button", { name: /Restore notes.txt/ })).toBeNull();
  expect(changes).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "Patch" })).toHaveTextContent("new");
});
