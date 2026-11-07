import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { WorktreeCleanup } from "./WorktreeCleanup";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));

const view = (value: unknown, source = "default") => ({ key: "worktree_cleanup", value, default: {}, source, project_scoped: true }) as never;
const serve = (value: unknown, source?: string) => vi.mocked(request).mockImplementation(async (method) =>
  (method === "PUT" ? { ...scopedFixture([view(value, source)], [view({})], "p1") } : scopedFixture([view(value, source)], [view({})], "p1")) as never);

beforeEach(() => vi.mocked(request).mockReset());

it("is off until switched on, and switching on sets the project's own seven days", async () => {
  serve({});
  const user = userEvent.setup();
  render(<WorktreeCleanup />);
  const toggle = await screen.findByRole("switch", { name: "Clean up finished worktrees" });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText("Merged or archived, untouched for 7 days")).toBeVisible();
  await user.click(toggle);
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({
    edits: { worktree_cleanup: { op: "set", value: { mode: "custom", rules: { settled_after_days: 7 } } } } })));
});

it("shows the project's saved days and switches off with mode off", async () => {
  serve({ mode: "custom", rules: { settled_after_days: 14 } }, "project");
  const user = userEvent.setup();
  render(<WorktreeCleanup />);
  const toggle = await screen.findByRole("switch", { name: "Clean up finished worktrees" });
  expect(toggle).toBeChecked();
  expect(screen.getByText("Merged or archived, untouched for 14 days")).toBeVisible();
  await user.click(toggle);
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({
    edits: { worktree_cleanup: { op: "set", value: { mode: "off" } } } })));
});
