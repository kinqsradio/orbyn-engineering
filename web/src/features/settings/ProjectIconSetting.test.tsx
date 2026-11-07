import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Project } from "../../api/types";
import type { ProjectScopeCatalog } from "../../generated/ProjectScopeCatalog";
import type { ProjectScopeCheckout } from "../../generated/ProjectScopeCheckout";
import { ProjectIconSetting } from "./ProjectIconSetting";

vi.mock("../../ui/badges", () => ({ ProjectBadge: () => <span>badge</span> }));

const member: ProjectScopeCheckout = {
  project_id: "p1", physical_key: "k1", name: "One", metadata_revision: "4", path: "/one",
  repository_key: null, repository_label: null, repository_relative_path: null,
  grouping_mode: "separate", metadata_complete: true, unavailable: null,
};
const catalog = { version: "v1", groups: [{ key: "g1", label: "One", members: [member] }], metadata_complete: true,
  selection: { kind: "checkout", group_key: "g1", project_id: "p1" } } as unknown as ProjectScopeCatalog;
const query = { selection: { kind: "checkout" as const, group_key: "g1", project_id: "p1" } };
const imported = `./.orbyn-imported/${"a".repeat(64)}.png`;

const setup = (attached: boolean) => {
  vi.spyOn(api, "shell").mockResolvedValue({ attached, windows: 1, facts: {} } as never);
  const reload = vi.fn();
  render(<ProjectIconSetting query={query} catalog={catalog} members={[member]} projectName="One" disabled={false} loading={false} reload={reload} />);
  return reload;
};

beforeEach(() => { vi.restoreAllMocks(); });

it("offers the computer's own dialog only in the desktop app", async () => {
  setup(false);
  expect(await screen.findByRole("button", { name: "Choose a project icon file" })).toBeVisible();
  await waitFor(() => expect(api.shell).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Choose a project icon from this computer" })).not.toBeInTheDocument();
});

it("asks the service with the observed revisions and applies what it returns", async () => {
  const chosen = vi.spyOn(api, "chooseProjectImage").mockResolvedValueOnce([
    { id: "p1", path: "/one", favicon_path: imported, metadata_revision: "5" } as Project,
  ]);
  const reload = setup(true);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Choose a project icon from this computer" }));
  expect(chosen).toHaveBeenCalledWith({ scope: query, membership_version: "v1", expected_revisions: { p1: "4" } });
  await waitFor(() => expect(reload).toHaveBeenCalled());
  expect(await screen.findByRole("button", { name: "Reset project icon" })).toBeVisible();
});

it("changes nothing when the dialog is cancelled", async () => {
  vi.spyOn(api, "chooseProjectImage").mockResolvedValueOnce(undefined);
  const reload = setup(true);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Choose a project icon from this computer" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose a project icon from this computer" })).toBeEnabled());
  expect(reload).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Reset project icon" })).toBeNull();
});
