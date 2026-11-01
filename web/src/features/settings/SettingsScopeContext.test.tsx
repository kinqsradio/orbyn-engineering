import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { ProjectScopeCatalog } from "../../generated/ProjectScopeCatalog";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import { navigate, useRoute } from "../../state/route";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import { ScopeSentence } from "./ScopeSentence";

vi.mock("../../api/client", async (original) => {
  const actual = await original<typeof import("../../api/client")>();
  return { ...actual, request: vi.fn(), api: { ...actual.api,
    info: vi.fn(async () => ({ version: "1", remote: false, platform: "test", environment_label: "Test computer" })),
  } };
});

const group = (key: string, label = key, count = 1) => ({ key, label, members: Array.from({ length: count }, (_, index) => ({
  project_id: `${key}-${index}`, physical_key: `${key}-physical-${index}`, name: `Checkout ${index}`, path: `/fixture/${key}/${index}`,
  repository_key: key, repository_label: label, repository_relative_path: "", grouping_mode: "repository" as const, metadata_complete: true, unavailable: null,
})) });

function respond(groups = [group("g1", "Project one", 2)]) {
  vi.mocked(request).mockImplementation(async (_method, _path, body) => {
    if (_path === "/api/info") return { version: "1", remote: false, platform: "test", environment_label: "Test computer" };
    const { selection } = body as ProjectScopesQuery;
    return { version: "v1", groups, metadata_complete: true,
      selection: selection && selection.kind !== "all_projects"
        ? groups.some((entry) => entry.key === selection.group_key) ? selection : { kind: "unavailable", reason: "project_missing" }
        : { kind: "all_projects" } };
  });
}

function Probe() {
  const context = useSettingsScope();
  return <><ScopeSentence /><output data-testid="query">{JSON.stringify(context?.query)}</output>
    <button onClick={() => navigate({ name: "settings", section: "appearance" })}>Appearance</button>
    <button onClick={() => navigate({ name: "settings", section: "worktrees" })}>Worktrees</button>
    <button onClick={() => context?.select({ kind: "checkout", group_key: "g1", project_id: "g1-1" })}>Open physical checkout</button>
    <button>After scope</button></>;
}
function Harness() {
  const route = useRoute();
  return <SettingsScopeProvider section={route.name === "settings" ? route.section ?? "general" : "general"}><Probe /></SettingsScopeProvider>;
}

it("selects a logical project and physical checkout, retaining IDs across device pages", async () => {
  respond(); window.location.hash = "#/settings/worktrees";
  const user = userEvent.setup(); render(<Harness />);
  expect(await screen.findByText("Test computer")).toBeVisible();
  await user.click(await screen.findByRole("button", { name: "Project scope: All projects" }));
  await user.click(screen.getByRole("menuitemradio", { name: "Project one" }));
  await user.click(screen.getByRole("button", { name: "Open physical checkout" }));
  await waitFor(() => expect(screen.getByTestId("query")).toHaveTextContent('"project_id":"g1-1"'));
  expect(window.location.hash).toContain("checkout=g1-1");
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  await waitFor(() => expect(screen.getByTestId("query")).toHaveTextContent("{}"));
  expect(screen.queryByText("Applying settings for")).not.toBeInTheDocument();
  expect(window.location.hash).toContain("checkout=g1-1");
  await user.click(screen.getByRole("button", { name: "Worktrees" }));
  await waitFor(() => expect(screen.getByTestId("query")).toHaveTextContent('"project_id":"g1-1"'));
});

it("keeps stale scope unavailable and lets the user explicitly recover", async () => {
  respond(); window.location.hash = "#/settings/worktrees?project=removed";
  const user = userEvent.setup(); render(<Harness />);
  await user.click(await screen.findByRole("button", { name: "Project scope: Unavailable project" }));
  expect(screen.getByText(/This selection is no longer available/)).toBeVisible();
  expect(screen.getByTestId("query")).toHaveTextContent('"group_key":"removed"');
  await user.click(screen.getByRole("menuitemradio", { name: "All projects" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Project scope: All projects" })).toBeEnabled());
  expect(window.location.hash).not.toContain("project=");
});

it("uses the ordinary menu for exactly six projects", async () => {
  respond(Array.from({ length: 6 }, (_, index) => group(`six-${index}`)));
  window.location.hash = "#/settings/worktrees";
  const user = userEvent.setup(); render(<Harness />);
  await user.click(await screen.findByRole("button", { name: "Project scope: All projects" }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(7);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("uses a searchable picker only above six projects and Tab advances without a focus reset", async () => {
  respond(Array.from({ length: 7 }, (_, index) => group(`g${index}`, `Project ${index}`)));
  window.location.hash = "#/settings/worktrees";
  const user = userEvent.setup(); render(<Harness />);
  await user.click(await screen.findByRole("button", { name: "Project scope: All projects" }));
  const search = screen.getByRole("combobox", { name: "Search projects" });
  await user.type(search, "Project 6");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("button", { name: "Project scope: Project 6" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Project scope: Project 6" }));
  await user.tab();
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search projects" })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Project scope: Project 6" })).not.toHaveFocus();
});

it("keeps a failed catalog blocked and exposes retry", async () => {
  vi.mocked(request).mockRejectedValue(new ApiFailure("unavailable", "Catalog unavailable", 503));
  window.location.hash = "#/settings/worktrees?project=g1";
  const user = userEvent.setup(); render(<Harness />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
  expect(screen.getByRole("button", { name: "Project scope: Unavailable project" })).toBeDisabled();
  respond();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Project scope: Project one" })).toBeEnabled());
});

it("does not expose a former catalog while a new selection is loading", async () => {
  respond(); window.location.hash = "#/settings/worktrees?project=g1";
  const user = userEvent.setup(); render(<Harness />);
  await screen.findByRole("button", { name: "Project scope: Project one" });
  let resolve!: (catalog: ProjectScopeCatalog) => void;
  vi.mocked(request).mockImplementation(() => new Promise((done) => { resolve = done; }));
  await user.click(screen.getByRole("button", { name: "Project scope: Project one" }));
  await user.click(screen.getByRole("menuitemradio", { name: "All projects" }));
  expect(await screen.findByRole("button", { name: "Project scope: Loading projects…" })).toBeDisabled();
  resolve({ version: "v2", groups: [], metadata_complete: true, selection: { kind: "all_projects" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Project scope: All projects" })).toBeEnabled());
});

it("keeps an unsupported machine unavailable until an explicit local selection", async () => {
  respond(); window.location.hash = "#/settings/worktrees?machine=missing&project=g1";
  const user = userEvent.setup(); render(<Harness />);
  await user.click(await screen.findByRole("button", { name: "Project scope: Unavailable project" }));
  expect(screen.getByTestId("query")).toHaveTextContent("unavailable:machine:missing");
  expect(window.location.hash).toContain("machine=missing");
  await user.click(screen.getByRole("menuitemradio", { name: "Project one" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Project scope: Project one" })).toBeEnabled());
  expect(window.location.hash).not.toContain("machine=");
});
