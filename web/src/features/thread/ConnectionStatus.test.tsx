import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { readShellStatus } from "../../api/shell";
import { markReachable, useConnection } from "../../state/connection";
import { ConnectionStatus, ServiceDownBanner } from "./ConnectionStatus";

afterEach(async () => {
  vi.restoreAllMocks();
  useConnection.setState({ offline: false, serviceDown: false, restarting: false, remote: false });
});

async function inDesktop(attached: boolean) {
  vi.spyOn(api, "shell").mockResolvedValue({ attached, windows: 1, facts: { cli: null, permissions: [] } });
  await readShellStatus();
}

it("shows Offline in the header and no banner when this device has no network", () => {
  useConnection.setState({ offline: true });
  render(<><ConnectionStatus /><ServiceDownBanner /></>);
  expect(screen.getByText("Offline")).toBeInTheDocument();
  expect(screen.queryByRole("status")).toBeNull();
});

it("names the Orbyn service, not the network, when it does not answer", () => {
  useConnection.setState({ serviceDown: true });
  render(<><ConnectionStatus /><ServiceDownBanner /></>);
  expect(screen.getByText("Paused")).toBeInTheDocument();
  expect(screen.getByText("Can’t reach the Orbyn service on this Mac.")).toBeInTheDocument();
  expect(screen.queryByText("Offline")).toBeNull();
});

it("offers Show log and Restart service through the desktop shell, and shows Restarting until the service answers", async () => {
  await inDesktop(true);
  const relay = vi.spyOn(api, "shellAction").mockResolvedValue(undefined);
  useConnection.setState({ serviceDown: true });
  const user = userEvent.setup();
  render(<><ConnectionStatus /><ServiceDownBanner /></>);
  await user.click(screen.getByRole("button", { name: "Show log" }));
  expect(relay).toHaveBeenLastCalledWith("show_log");
  await user.click(screen.getByRole("button", { name: "Restart service" }));
  expect(relay).toHaveBeenLastCalledWith("restart_service");
  expect(await screen.findByText("Restarting the Orbyn service. Your drafts are kept.")).toBeInTheDocument();
  expect(screen.getByText("Restarting")).toBeInTheDocument();
  expect(screen.queryByText("Paused")).toBeNull();
  expect(screen.queryByRole("button", { name: "Restart service" })).toBeNull();

  markReachable();
  expect(useConnection.getState().restarting).toBe(false);
});

it("hides Show log and Restart service from a remote viewer and from a browser outside the desktop app", async () => {
  useConnection.setState({ serviceDown: true, remote: true });
  await inDesktop(true);
  const view = render(<ServiceDownBanner />);
  expect(screen.getByText("Can’t reach the Orbyn service on this Mac.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restart service" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Show log" })).toBeNull();

  view.unmount();
  useConnection.setState({ remote: false });
  await inDesktop(false);
  render(<ServiceDownBanner />);
  expect(screen.queryByRole("button", { name: "Restart service" })).toBeNull();
});
