import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, request } from "../../api/client";
import { GeneralSection } from "./PreferenceSections";
import { EnvironmentCleanup, MaintenanceSection } from "./Maintenance";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";
vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
beforeEach(() => vi.mocked(request).mockReset());
afterEach(() => vi.restoreAllMocks());
it("keeps provider update preferences without a saved-login choice", async () => {
  vi.spyOn(api, "shell").mockResolvedValue({ attached: false, windows: 0, facts: { cli: null, permissions: [] } });
  vi.mocked(request).mockResolvedValue(scopedFixture([
    { key: "enable_provider_update_checks", value: true, default: true, source: "default", project_scoped: false },
    { key: "prefer_saved_login", value: true, default: false, source: "global", project_scoped: false },
  ]));
  render(<GeneralSection />);
  expect(await screen.findByRole("switch", { name: "Check providers for updates" })).toBeChecked();
  expect(screen.queryByRole("switch", { name: "Prefer saved login" })).toBeNull();
});
it("keeps diagnostics and update controls without requesting a Network inventory", async () => {
  vi.spyOn(api, "settings").mockResolvedValue({ background_update_checks: true } as Awaited<ReturnType<typeof api.settings>>);
  vi.mocked(request).mockImplementation(async (_method, path) => {
    if (path === "/api/diagnostics") return { version: "fixture", pid: 1, active_runs: 0, terminals: 0,
      database: { bytes: 0, reclaimable_bytes: 0 }, history: [], processes: [], events: [] } as never;
    if (path === "/api/network") return [{ purpose: "Automatic request", host: "fixture.invalid", cadence: "daily", control: "Off", enabled: false }] as never;
    return [] as never;
  });
  render(<MaintenanceSection />);
  expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Repair" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  expect(screen.queryByRole("heading", { name: "Network" })).toBeNull();
  expect(request).not.toHaveBeenCalledWith("GET", "/api/network", undefined, expect.any(AbortSignal));
});
it("asks before deleting old files and runs the cleanup only on confirm", async () => {
  vi.spyOn(api, "settings").mockResolvedValue({ background_update_checks: true } as Awaited<ReturnType<typeof api.settings>>);
  const user = userEvent.setup();
  vi.mocked(request).mockImplementation(async (method, path) => {
    if (path === "/api/diagnostics") return { version: "f", pid: 1, active_runs: 0, terminals: 0, database: { bytes: 0, reclaimable_bytes: 0 }, history: [], processes: [], events: [] } as never;
    if (path === "/api/settings/preferences/query") return scopedFixture([
      { key: "storage_cleanup", value: { browser_artifacts_after_days: 14 }, default: {}, source: "global", project_scoped: false },
      { key: "worktree_cleanup", value: {}, default: {}, source: "default", project_scoped: false },
    ]) as never;
    if (method === "GET" && path === "/api/storage/cleanup") return null as never;
    if (method === "POST" && path === "/api/storage/cleanup?dry_run=true") return { dry_run: true, ran_at: "2026-11-07T00:00:00Z", entries: [
      { kind: "artifact", path: "/data/a.png", removed: false, reason: "Older than 14 days" },
      { kind: "artifact", path: "/data/b.png", removed: false, reason: "Older than 14 days" }] } as never;
    if (method === "POST" && path === "/api/storage/cleanup") return { dry_run: false, ran_at: "2026-11-07T00:00:00Z", entries: [] } as never;
    return [] as never;
  });
  render(<EnvironmentCleanup query={{}} disabled={false} />);
  await user.click(await screen.findByRole("button", { name: "Delete now…" }));
  const ask = await screen.findByRole("dialog", { name: "Delete old files now?" });
  expect(vi.mocked(request)).not.toHaveBeenCalledWith("POST", "/api/storage/cleanup");
  expect(within(ask).getByText("Browser artifacts older than 14 days")).toBeVisible();
  expect(within(ask).getByText("2")).toBeVisible();
  expect(screen.getByText("Would delete 2 browser artifacts")).toBeVisible();
  await user.click(within(ask).getByRole("button", { name: "Delete now" }));
  await waitFor(() => expect(vi.mocked(request)).toHaveBeenCalledWith("POST", "/api/storage/cleanup"));
});
