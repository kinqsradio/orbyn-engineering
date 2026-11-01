import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { LimitBanner } from "./ThreadBanners";

const reset = "2100-01-01T00:00:00Z";
const thread: Thread = { id: "t", project_id: "p", title: "Limited", engine: "codex", model: null,
  cwd: "/fixture", worktree: null, skill_profile: null, scratch: false, active_run: null, last_run_state: "failed", created_at: "", updated_at: "",
  lifecycle: { pinned_at: null, archived_at: null, settled_at: null, snoozed_until: null, unread: false, auto_settle: null,
    position: 0, parent_thread_id: null, relation: null, permission_mode: "supervised", plan_mode: false,
    limit: { message: "Usage limit reached", stopped_at: "2026-11-01T00:00:00Z", resets_at: reset, resume_at: null } } };
afterEach(() => vi.restoreAllMocks());

it("schedules and cancels auto-resume through the existing thread patch", async () => {
  const user = userEvent.setup(); const patch = vi.spyOn(api, "patchThread").mockResolvedValue(thread);
  const view = render(<LimitBanner thread={thread} />);
  await user.click(screen.getByRole("button", { name: "Resume at reset" }));
  expect(patch).toHaveBeenCalledExactlyOnceWith("t", { resume_at_reset: true });
  view.rerender(<LimitBanner thread={{ ...thread, lifecycle: { ...thread.lifecycle!, limit: { ...thread.lifecycle!.limit!, resume_at: reset } } }} />);
  await user.click(screen.getByRole("button", { name: "Cancel auto-resume" }));
  expect(patch).toHaveBeenLastCalledWith("t", { resume_at_reset: false });
});

it("offers Wake now for a matching reset snooze without starting a run", async () => {
  const user = userEvent.setup(); const patch = vi.spyOn(api, "patchThread").mockResolvedValue(thread);
  const run = vi.spyOn(api, "startRun");
  render(<LimitBanner thread={{ ...thread, lifecycle: { ...thread.lifecycle!, snoozed_until: "2100-01-01T01:00:00+01:00" } }} />);
  expect(screen.queryByRole("button", { name: "Snooze until reset" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Wake now" }));
  await waitFor(() => expect(patch).toHaveBeenCalledExactlyOnceWith("t", { wake: true }));
  expect(run).not.toHaveBeenCalled();
});

it("keeps the reset snooze action for a thread not snoozed until that instant", async () => {
  const user = userEvent.setup(); const patch = vi.spyOn(api, "patchThread").mockResolvedValue(thread);
  render(<LimitBanner thread={thread} />);
  await user.click(screen.getByRole("button", { name: "Snooze until reset" }));
  expect(patch).toHaveBeenCalledExactlyOnceWith("t", { snoozed_until: reset });
});
