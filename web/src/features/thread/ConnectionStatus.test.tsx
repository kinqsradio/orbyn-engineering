import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { readShellStatus } from "../../api/shell";
import { checkConnectionNow, useConnection, watchConnection } from "../../state/connection";
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

const MENU_LINE = "To restart the service, use the app’s menu: Orbyn › Restart service.";

it("points the desktop app's person to its menu and has no Restart service or Show log buttons", async () => {
  await inDesktop(true);
  useConnection.setState({ serviceDown: true });
  render(<ServiceDownBanner />);
  expect(screen.getByText(MENU_LINE)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restart service" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Show log" })).toBeNull();
});

it("shows only Check again, with no menu line, in a plain browser and to a remote viewer", async () => {
  useConnection.setState({ serviceDown: true, remote: true });
  await inDesktop(true);
  const view = render(<ServiceDownBanner />);
  expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  expect(screen.queryByText(MENU_LINE)).toBeNull();

  view.unmount();
  useConnection.setState({ remote: false });
  await inDesktop(false);
  render(<ServiceDownBanner />);
  expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  expect(screen.queryByText(MENU_LINE)).toBeNull();
});

it("Check again asks the service at once and clears the banner when it answers", async () => {
  useConnection.setState({ serviceDown: true });
  const probe = vi.fn().mockResolvedValue(undefined);
  const stop = watchConnection(probe);
  render(<ServiceDownBanner />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(useConnection.getState().serviceDown).toBe(false));
  expect(probe).toHaveBeenCalledTimes(1);
  stop();
});

it("ignores a probe that answers after the watcher stopped", async () => {
  useConnection.setState({ serviceDown: true });
  let answer: () => void = () => undefined;
  const stop = watchConnection(() => new Promise<void>((resolve) => { answer = resolve; }));
  checkConnectionNow();
  stop();
  answer();
  await Promise.resolve();
  expect(useConnection.getState().serviceDown).toBe(true);
});
