import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { useRoute } from "../../state/route";
import { SettingsPage } from "./SettingsPage";
import { SETTINGS, searchSettings } from "./settingsSearch";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));

it("finds a specific label regardless of word order and excludes desktop controls on web", () => {
  expect(searchSettings("prefix BRANCH", false).map((item) => item.title)).toEqual(["Branch prefix"]);
  expect(searchSettings("command line tool", false)).toEqual([]);
  expect(searchSettings("command line tool", true)).toHaveLength(1);
  expect(searchSettings("  ", true)).toEqual([]);
  expect(searchSettings("Accessibility", true, new Set(["cli"]))).toEqual([]);
  expect(searchSettings("Accessibility", true, new Set(["accessibility"]))).toHaveLength(1);
  expect(searchSettings("App updates", true, new Set())).toEqual([]);
  expect(searchSettings("Worktree location", true)).toEqual([]);
  expect(new Set(SETTINGS.map((item) => item.id)).size).toBe(SETTINGS.length);
});

it("navigates from an exact result to an asynchronously loaded row inside Advanced", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockImplementation(async (_method, path) => {
    if (path === "/api/shell") return { attached: false };
    if (path === "/api/info") return { version: "1", remote: false, platform: "test", environment_label: "Test computer" };
    const catalog = { version: "fixture", groups: [], metadata_complete: true, selection: { kind: "all_projects" } };
    if (path === "/api/settings/project-scopes") return catalog;
    if (path === "/api/settings/preferences/query") return { catalog, rows: [{ key: "branch_name_prefix", value: "feat", default: "feat", mixed: false, project_scoped: true, revision: "fixture", environment: { key: "branch_name_prefix", value: "feat", default: "feat", source: "default", project_scoped: true }, members: [], overrides: [] }] };
    return [];
  });
  window.location.hash = "#/settings/general";
  function Harness() {
    const route = useRoute();
    return <SettingsPage section={route.name === "settings" ? route.section : null} onClose={() => undefined} />;
  }
  render(<Harness />);
  await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "Branch prefix");
  await user.click(screen.getByRole("link", { name: "Branch prefix · Worktrees" }));
  const control = await screen.findByRole("textbox", { name: "Branch prefix" });
  await waitFor(() => expect(control.closest(".setting-line")).toHaveFocus());
  expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
  // Choosing the same result again must reveal it after a manual close.
  await user.click(screen.getByRole("button", { name: "Advanced" }));
  await waitFor(() => expect(control).not.toBeVisible());
  await user.click(screen.getByRole("link", { name: "Branch prefix · Worktrees" }));
  await waitFor(() => expect(control.closest(".setting-line")).toHaveFocus());
  await user.clear(screen.getByRole("searchbox", { name: "Search settings" }));
  await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "unmatched setting");
  expect(screen.getByRole("status")).toHaveTextContent("No settings found");
});
