import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useConnection } from "../../state/connection";
import { ConnectionStatus, ServiceDownBanner } from "./ConnectionStatus";

afterEach(() => useConnection.setState({ offline: false, serviceDown: false }));

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
