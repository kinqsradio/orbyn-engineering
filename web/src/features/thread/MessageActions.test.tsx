import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { MessageActions, ThreadScope } from "./MessageActions";
const thread: Thread = { id: "t", project_id: "p", title: "Thread", engine: "codex", model: null,
  cwd: "/fixture", worktree: null, skill_profile: null, scratch: false, active_run: null,
  last_run_state: null, created_at: "", updated_at: "" };
beforeEach(() => useWorkspace.getState().putThread(thread));
afterEach(() => vi.restoreAllMocks());
it("edits a user message in the same thread without offering another fork action", async () => {
  const user = userEvent.setup();
  const rewind = vi.spyOn(api, "rewindThread").mockResolvedValue(undefined);
  vi.spyOn(api, "thread").mockResolvedValue(thread);
  const fork = vi.spyOn(api, "forkBefore");
  render(<ThreadScope value="t"><MessageActions text="Original prompt" runId="r" role="user" /></ThreadScope>);
  expect(screen.queryByRole("button", { name: "Edit in a new thread" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy message" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Edit from here" }));
  await user.click(screen.getByRole("button", { name: "Rewind" }));
  await waitFor(() => expect(rewind).toHaveBeenCalledExactlyOnceWith("t", "r", false));
  expect(useUi.getState().drafts.t).toBe("Original prompt");
  expect(fork).not.toHaveBeenCalled();
});
it("keeps assistant forks and whole-checkpoint restore", async () => {
  const user = userEvent.setup();
  const fork = vi.spyOn(api, "forkThread").mockResolvedValue({ ...thread, id: "child" });
  const restore = vi.spyOn(api, "restoreWorkspace").mockResolvedValue(undefined);
  render(<ThreadScope value="t"><MessageActions text="Answer" runId="r" role="assistant" /></ThreadScope>);
  await user.click(screen.getByRole("button", { name: "Fork from this response" }));
  await waitFor(() => expect(useWorkspace.getState().threads.child).toBeDefined());
  expect(fork).toHaveBeenCalledExactlyOnceWith("t", "r");
  await user.click(screen.getByRole("button", { name: "Restore files to before this response" }));
  await user.click(screen.getByRole("button", { name: "Restore files" }));
  await waitFor(() => expect(restore).toHaveBeenCalledExactlyOnceWith("t", "r", "start"));
});
