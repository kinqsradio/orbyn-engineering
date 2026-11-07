import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiFailure, request } from "../../api/client";
import { useConnection } from "../../state/connection";
import { useWorkspace } from "../../state/workspace";
import { MaintenanceSection } from "./Maintenance";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));

const hour = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const diagnostics = (events: unknown[]) => ({ version: "0.42.1", pid: 1, active_runs: 2, terminals: 0,
  database: { bytes: 41_000_000, reclaimable_bytes: 0 }, history: [{ at: hour(0), memory_bytes: 182_000_000, processes: 1 }],
  processes: [], events });
const app = (extra: object = {}) => ({ library: { incoming: [], blocked_reason: null }, engines: [], checked_at: null, error: null,
  app: { current: "0.42.1", latest: null, notes: null, mode: "browser", can_apply: false, blocked_reason: null, unconfigured: false, ...extra } }) as never;

const serve = (read: () => unknown) => vi.mocked(request).mockImplementation(async (_method, path) => {
  if (path === "/api/diagnostics") return read() as never;
  if (path === "/api/settings/preferences/query") return scopedFixture([]) as never;
  return null as never;
});

beforeEach(() => {
  vi.mocked(request).mockReset();
  vi.spyOn(api, "settings").mockResolvedValue({ background_update_checks: true } as Awaited<ReturnType<typeof api.settings>>);
  useConnection.setState({ offline: false });
  useWorkspace.getState().putUpdates(app());
});
afterEach(() => vi.restoreAllMocks());

it("shows the service facts and lists recent problems from the last 24 hours only when asked", async () => {
  serve(() => diagnostics([{ at: hour(1), level: "WARN", target: "t", message: "Codex health check timed out." },
    { at: hour(30), level: "ERROR", target: "t", message: "Too old to list." }]));
  const user = userEvent.setup();
  render(<MaintenanceSection />);
  const card = await screen.findByRole("group", { name: "Service" });
  expect(within(card).getByText("Running · 0.42.1")).toBeVisible();
  expect(within(card).getByText("2 threads running")).toBeVisible();
  expect(within(card).getByText("41 MB")).toBeVisible();
  expect(within(card).getByText("182 MB")).toBeVisible();
  expect(screen.getByText("1 in the last 24 hours")).toBeVisible();
  expect(screen.queryByText("Codex health check timed out.")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Show" }));
  expect(screen.getByText("Codex health check timed out.")).toBeVisible();
  expect(screen.queryByText("Too old to list.")).toBeNull();
});

it("says there are no problems instead of showing an empty list", async () => {
  serve(() => diagnostics([]));
  render(<MaintenanceSection />);
  expect(await screen.findByText("Nothing went wrong in the last 24 hours.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
});

it("says so when the service can't be asked", async () => {
  vi.mocked(request).mockImplementation(async (_method, path) => {
    if (path === "/api/diagnostics") throw new ApiFailure("network_error", "down", 0);
    return scopedFixture([]) as never;
  });
  render(<MaintenanceSection />);
  expect(await screen.findByText("Can’t reach the Orbyn service, so there is nothing to show.")).toBeVisible();
});

it("offers Restart to update once the update is downloaded", async () => {
  serve(() => diagnostics([]));
  useWorkspace.getState().putUpdates(app({ latest: "0.43.0", can_apply: true, downloaded: 10, total: 10 }));
  const apply = vi.spyOn(api, "applyAppUpdate").mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<MaintenanceSection />);
  expect(await screen.findByText("0.42.1 · 0.43.0 is downloaded")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Restart to update" }));
  await waitFor(() => expect(apply).toHaveBeenCalled());
});

it("says a failed check with Retry, and offline without offering the check", async () => {
  serve(() => diagnostics([]));
  vi.spyOn(api, "checkUpdates").mockRejectedValue(new ApiFailure("bad_gateway", "The update server didn’t answer.", 502));
  const user = userEvent.setup();
  render(<MaintenanceSection />);
  await user.click(await screen.findByRole("button", { name: "Check for updates" }));
  const banner = (await screen.findByText(/Couldn’t check for updates\. The update server didn’t answer\./)).closest<HTMLElement>("[role=alert]")!;
  expect(within(banner).getByRole("button", { name: "Retry" })).toBeVisible();
  useConnection.setState({ offline: true });
  expect(await screen.findByText("You’re offline. Updates are checked when you’re back.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
});

it("shows the download with its percentage and no button, then Restart to update", async () => {
  serve(() => diagnostics([]));
  useWorkspace.getState().putUpdates(app({ latest: "0.43.0", can_apply: true, downloaded: 42, total: 100 }));
  render(<MaintenanceSection />);
  expect(await screen.findByText(/Downloading 0\.43\.0…/)).toBeVisible();
  expect(screen.getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("aria-valuenow", "42");
  expect(screen.getByText("42%")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
});

it("asks before repairing the database, with Cancel focused", async () => {
  serve(() => diagnostics([]));
  const user = userEvent.setup();
  render(<MaintenanceSection />);
  await user.click(await screen.findByRole("button", { name: "Repair database" }));
  const ask = await screen.findByRole("dialog", { name: "Repair the database?" });
  expect(within(ask).getByText("Orbyn will check and repair its local database. Threads aren’t deleted.")).toBeVisible();
  await waitFor(() => expect(within(ask).getByRole("button", { name: "Cancel" })).toHaveFocus());
  expect(vi.mocked(request)).not.toHaveBeenCalledWith("POST", "/api/diagnostics/repair");
  await user.click(within(ask).getByRole("button", { name: "Repair database" }));
  await waitFor(() => expect(vi.mocked(request)).toHaveBeenCalledWith("POST", "/api/diagnostics/repair"));
});

it("lists running processes with a red Stop that asks first, and says when there are none", async () => {
  const proc = (pid: number, name: string, running_seconds: number) => ({ pid, parent: 1, name, memory_bytes: 1, running_seconds });
  serve(() => ({ ...diagnostics([]), processes: [proc(1, "orbynd", 9000), proc(7, "claude", 3700)] }));
  const user = userEvent.setup();
  const { unmount } = render(<MaintenanceSection />);
  expect(await screen.findByText("Running 1h")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Stop orbynd" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Stop claude" }));
  const ask = await screen.findByRole("dialog", { name: "Stop claude?" });
  expect(within(ask).getByText("It stops now. Threads that use it end their current turn.")).toBeVisible();
  await waitFor(() => expect(within(ask).getByRole("button", { name: "Cancel" })).toHaveFocus());
  expect(vi.mocked(request)).not.toHaveBeenCalledWith("POST", "/api/diagnostics/processes/7/stop");
  await user.click(within(ask).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(vi.mocked(request)).toHaveBeenCalledWith("POST", "/api/diagnostics/processes/7/stop"));
  unmount();
  serve(() => ({ ...diagnostics([]), processes: [proc(1, "orbynd", 9000)] }));
  render(<MaintenanceSection />);
  expect(await screen.findByText("No running processes.")).toBeVisible();
});
