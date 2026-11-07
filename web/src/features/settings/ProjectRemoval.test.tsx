import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, request } from "../../api/client";
import type { ProjectScopeCheckout } from "../../generated/ProjectScopeCheckout";
import type { ProjectScopeGroup } from "../../generated/ProjectScopeGroup";
import { ProjectRemoval } from "./Projects";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));

const member: ProjectScopeCheckout = {
  project_id: "p1", physical_key: "k1", name: "orbyn-engineering", path: "/code/orbyn-engineering",
  repository_key: null, repository_label: null, repository_relative_path: null,
  grouping_mode: "separate", metadata_complete: true, unavailable: null,
};
const group: ProjectScopeGroup = { key: "g1", label: "orbyn-engineering", members: [member] };
const query = { selection: { kind: "checkout" as const, group_key: "g1", project_id: "p1" } };

beforeEach(() => {
  vi.mocked(request).mockReset();
  vi.mocked(request).mockImplementation(async (_method, path) =>
    (String(path).includes("archived=true") ? [{ id: "t3" }] : [{ id: "t1" }, { id: "t2" }]) as never);
});

it("asks again in a dialog with Cancel focused and says the threads stay in Archive", async () => {
  const remove = vi.spyOn(api, "removeProject").mockResolvedValue(undefined as never);
  const user = userEvent.setup();
  render(<ProjectRemoval query={query} group={group} members={[member]} disabled={false} reload={() => {}} clearSelection={() => {}} />);
  expect(screen.getByText("Stops tracking it in Orbyn. Files on disk stay.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove…" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove orbyn-engineering?" });
  expect(within(dialog).getByText("Orbyn stops tracking this project. Files on disk are not touched.")).toBeVisible();
  expect(within(dialog).getByText("/code/orbyn-engineering")).toBeVisible();
  expect(within(dialog).getByText("3 · stay in Archive")).toBeVisible();
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
  expect(remove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Remove project" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("p1", false));
});
