import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewTab } from "../../api/types";
import { useConnection } from "../../state/connection";
import { BrowserPanel, isLocalUrl } from "./BrowserPanel";
import { useBrowserPanels } from "./browserPanels";

class FakeSocket {
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
}

/** One open tab at `url`. */
function serve(url: string) {
  const tab: PreviewTab = {
    id: "one", thread_id: "t", url, title: "page", control: "none", recording: false, viewers: 0,
    width: 1280, height: 800, can_go_back: false, can_go_forward: false, zoom: 1, appearance: "system",
    mobile: false, private: false, profile: null, opened_by: "person", crashed: false,
  };
  vi.stubGlobal("fetch", async (path: string) => {
    const body = path === "/api/shell" ? { attached: false, windows: 1, facts: {} } : path.endsWith("/previews") ? [tab] : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  useBrowserPanels.setState({ moved: {} });
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => vi.restoreAllMocks());

describe("which pages need the network or the service", () => {
  it("counts only pages on this machine as local", () => {
    for (const url of ["http://localhost:5173/login", "http://127.0.0.1:3000", "http://[::1]:8080/", "http://app.localhost/"]) {
      expect(isLocalUrl(url), url).toBe(true);
    }
    for (const url of ["https://example.com", "https://localhost.example.com", "not a url", ""]) {
      expect(isLocalUrl(url), url).toBe(false);
    }
  });
});

describe("the Browser without the network", () => {
  it("says the page needs the network, with Retry that looks again", async () => {
    serve("https://example.com/login");
    useConnection.setState({ offline: true });
    const user = userEvent.setup();
    render(<BrowserPanel threadId="t" />);
    expect(await screen.findByText("You’re offline")).toBeInTheDocument();
    expect(screen.getByText("Pages that need the network will load when you’re back.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Search or enter URL" })).not.toBeInTheDocument();
    // The device is back: Retry reads the network again and the page returns.
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(useConnection.getState().offline).toBe(false);
    expect(await screen.findByRole("combobox", { name: "Search or enter URL" })).toBeInTheDocument();
  });

  it("still opens a page on this machine", async () => {
    serve("http://localhost:5173/login");
    useConnection.setState({ offline: true });
    render(<BrowserPanel threadId="t" />);
    expect(await screen.findByRole("combobox", { name: "Search or enter URL" })).toBeInTheDocument();
    expect(screen.queryByText("You’re offline")).not.toBeInTheDocument();
  });
});

describe("the Browser while the Orbyn service is away", () => {
  it("stays usable and turns off only what sends to the thread, with a line that says why", async () => {
    serve("http://localhost:5173/login");
    useConnection.setState({ serviceDown: true });
    render(<BrowserPanel threadId="t" />);
    expect(await screen.findByRole("combobox", { name: "Search or enter URL" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Pick element, unavailable" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Reload" })).toBeEnabled();
    expect(await screen.findByText("Sending to the thread is paused while the service is away.")).toBeInTheDocument();
  });

  it("offers Pick element and no note while the service answers", async () => {
    serve("http://localhost:5173/login");
    render(<BrowserPanel threadId="t" />);
    expect(await screen.findByRole("button", { name: "Pick an element" })).toBeEnabled();
    expect(screen.queryByText("Sending to the thread is paused while the service is away.")).not.toBeInTheDocument();
  });
});
