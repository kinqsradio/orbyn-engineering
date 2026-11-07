import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { WorktreeCleanup } from "./WorktreeCleanup";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));

const view = (value: unknown, source = "default") => ({ key: "worktree_cleanup", value, default: {}, source, project_scoped: true }) as never;
const serve = (value: unknown, source?: string) => vi.mocked(request).mockImplementation(async () =>
  scopedFixture([view(value, source)], [view({})], "p1") as never);
const sent = (value: unknown) => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({ edits: { worktree_cleanup: { op: "set", value } } }));

beforeEach(() => vi.mocked(request).mockReset());

it("is Off with no Days field until set to On, which starts at seven days", async () => {
  serve({});
  const user = userEvent.setup();
  render(<WorktreeCleanup />);
  const select = await screen.findByRole("combobox", { name: "Automatic worktree cleanup" });
  expect(select).toHaveValue("off");
  expect(screen.queryByRole("spinbutton")).toBeNull();
  await user.selectOptions(select, "on");
  await waitFor(() => sent({ mode: "custom", rules: { settled_after_days: 7 } }));
});

it("shows the saved days beside On, saves a new number on leaving it, and Off hides it", async () => {
  serve({ mode: "custom", rules: { settled_after_days: 14 } }, "project");
  const user = userEvent.setup();
  render(<WorktreeCleanup />);
  const days = await screen.findByRole("spinbutton", { name: "Automatic worktree cleanup: days" });
  expect(days).toHaveValue(14);
  await user.clear(days); await user.type(days, "3"); await user.tab();
  await waitFor(() => sent({ mode: "custom", rules: { settled_after_days: 3 } }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Automatic worktree cleanup" }), "off");
  await waitFor(() => sent({ mode: "off" }));
});
