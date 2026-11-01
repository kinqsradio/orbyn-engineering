import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, request } from "../../api/client";
import { GeneralSection } from "./PreferenceSections";
import { MaintenanceSection } from "./Maintenance";
vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
beforeEach(() => vi.mocked(request).mockReset());
afterEach(() => vi.restoreAllMocks());
it("keeps provider update preferences without a saved-login choice", async () => {
  vi.spyOn(api, "shell").mockResolvedValue({ attached: false, windows: 0, facts: { cli: null, permissions: [] } });
  vi.mocked(request).mockResolvedValue([
    { key: "enable_provider_update_checks", value: true, default: true, source: "default", project_scoped: false },
    { key: "prefer_saved_login", value: true, default: false, source: "global", project_scoped: false },
  ]);
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
