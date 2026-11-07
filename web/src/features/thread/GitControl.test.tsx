import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api, ApiFailure } from "../../api/client";
import type { Thread } from "../../api/types";
import { BranchRow, GitActions } from "./GitControl";

const thread: Thread = { id: "writing", project_id: "project", title: "Task", engine: "claude", model: "chosen",
  cwd: "/checkout", worktree: null, skill_profile: null, active_run: null, last_run_state: null,
  created_at: "", updated_at: "", scratch: false };

afterEach(() => vi.restoreAllMocks());

async function open(label: string) {
  const user = userEvent.setup();
  vi.spyOn(api, "branches").mockResolvedValue([]);
  const action = vi.spyOn(api, "gitAction").mockRejectedValue(new ApiFailure("unsupported", "Generation unavailable. Enter text manually.", 422));
  render(<GitActions thread={thread} />);
  await user.click(screen.getByRole("button", { name: "Git" }));
  await user.click(screen.getByRole("menuitem", { name: label }));
  return { user, action, dialog: within(screen.getByRole("dialog")) };
}

it("opening, typing and cancelling never start generation or Git effects", async () => {
  const { user, action, dialog } = await open("Commit");
  await user.type(dialog.getByLabelText("Commit message"), "draft");
  expect(action).not.toHaveBeenCalled();
  await user.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(action).not.toHaveBeenCalled();
});

it("blank text requests generation only on the explicit action and leaves manual recovery", async () => {
  const { user, action, dialog } = await open("Commit, push and create pull request");
  expect(dialog.getByText(/Leave text blank to auto-generate/)).toBeVisible();
  await user.click(dialog.getByRole("button", { name: "Commit, push and create pull request" }));
  expect(action).toHaveBeenCalledExactlyOnceWith("writing", { commit_message: "", push: true, pull_request: { title: "", body: "" } });
  expect(await dialog.findByRole("alert")).toHaveTextContent("Generation unavailable");
  await user.type(dialog.getByLabelText("Commit message"), "  keep my text  ");
  await user.type(dialog.getByLabelText("Pull request title"), "Manual title");
  await user.type(dialog.getByLabelText("Description"), "Manual body");
  await user.click(dialog.getByRole("button", { name: "Commit, push and create pull request" }));
  expect(action).toHaveBeenLastCalledWith("writing", { commit_message: "  keep my text  ", push: true,
    pull_request: { title: "Manual title", body: "Manual body" } });
});

it("push-only sends no request for generated content", async () => {
  const { user, action, dialog } = await open("Push");
  expect(dialog.queryByText(/auto-generate/)).toBeNull();
  await user.click(dialog.getByRole("button", { name: "Push" }));
  expect(action).toHaveBeenCalledExactlyOnceWith("writing", { push: true });
});

it("a generation fallback shows its notice with the result", async () => {
  const { user, action, dialog } = await open("Commit");
  action.mockResolvedValueOnce({ phases: [{ name: "commit", ok: true, message: null, url: null }],
    notice: "Text was not generated, so the thread title was used. This change is too large to generate text." });
  await user.click(dialog.getByRole("button", { name: "Commit" }));
  expect(await dialog.findByRole("status")).toHaveTextContent("thread title was used");
});

it("a name that matches no branch shows the Create row and Enter creates it", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "branches").mockResolvedValue([{ name: "main", current: true, remote: false }] as never);
  const create = vi.spyOn(api, "createBranch").mockResolvedValue(undefined);
  render(<BranchRow thread={thread} branch="main" />);
  await user.click(screen.getByRole("button", { name: "Branch main" }));
  const dialog = within(screen.getByRole("dialog"));
  await user.type(dialog.getByLabelText("Search branches"), "fix/login-2");
  expect(dialog.getByRole("button", { name: /^Create branch “fix\/login-2”/ })).toBeVisible();
  expect(dialog.getByText("No branch matches. Enter creates it from the current branch and switches to it.")).toBeVisible();
  await user.keyboard("{Enter}");
  expect(create).toHaveBeenCalledExactlyOnceWith("writing", "fix/login-2");
});
