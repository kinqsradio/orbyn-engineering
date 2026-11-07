import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { WorktreesSection } from "./PreferenceSections";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));

const view = (key: string, value: unknown) => ({ key, value, default: value, source: "default", project_scoped: true }) as never;
const serve = (mode: string, prefix = "orbyn") => vi.mocked(request).mockImplementation(async () =>
  scopedFixture([view("branch_naming_mode", mode), view("branch_name_prefix", prefix), view("branch_name_instructions", "")]) as never);

beforeEach(() => vi.mocked(request).mockReset());

it("says what the chosen naming mode does, and shows the instructions only for Custom", async () => {
  serve("static");
  const { unmount } = render(<WorktreesSection />);
  expect(await screen.findByText("The prefix plus a fixed name.")).toBeVisible();
  expect(screen.getByRole("radio", { name: "From the thread" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Branch name instructions" })).toBeNull();
  unmount();
  serve("semantic");
  const second = render(<WorktreesSection />);
  expect(await screen.findByText("Named from the thread automatically.")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Branch name instructions" })).toBeNull();
  second.unmount();
  serve("custom");
  render(<WorktreesSection />);
  expect(await screen.findByText("Named using your branch name instructions.")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Branch name instructions" })).toBeVisible();
});

it("keeps the prefix without a slash, previews the branch name, and saves it trimmed", async () => {
  serve("static", "orbyn");
  const user = userEvent.setup();
  render(<WorktreesSection />);
  expect(await screen.findByText("A / is added after the prefix.")).toBeVisible();
  const field = screen.getByRole("textbox", { name: "Branch prefix" });
  expect(screen.getByText("orbyn/fix-login")).toBeVisible();
  await user.clear(field); await user.type(field, "feat/"); 
  expect(screen.getByText("feat/fix-login")).toBeVisible();
  await user.tab();
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({
    edits: { branch_name_prefix: { op: "set", value: "feat" } } })));
});
