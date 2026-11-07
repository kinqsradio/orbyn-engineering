import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { useConnection } from "../../state/connection";
import { useUi, type RightTab } from "../../state/ui";
import { useClosedTabs } from "./closedTabs";
import { SurfacePane, type PaneMode } from "./SurfacePane";

vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => <div>Browser content</div> }));
vi.mock("./DiffPanel", () => ({ DiffPanel: () => <div>Diff content</div> }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => <div>Files content</div> }));
vi.mock("./ActivityPanel", () => ({ ActivityPanel: () => null }));
vi.mock("./LinkedPulls", () => ({ LinkedPulls: () => <div>Linked pulls content</div> }));
vi.mock("./SideChatPane", () => ({ SideChatPane: () => <div>Side chat content</div> }));
vi.mock("./sideChat", () => ({ openSideChat: vi.fn(), closeSideChat: vi.fn() }));

const thread = { id: "thread-1" } as Thread;

beforeEach(() => {
  vi.spyOn(api, "diff").mockResolvedValue([]);
  useConnection.setState({ offline: false, serviceDown: false });
  useUi.setState({ panelOpen: true, panelTab: null, terminalOpen: false, pullReveal: null });
  useClosedTabs.setState({ closed: [] });
});

function pane(props: { mode?: PaneMode; onReturn?: () => void; onToggleMaximize?: () => void; maximized?: boolean } = {}) {
  return render(
    <SurfacePane
      thread={thread}
      mode={props.mode ?? "docked"}
      closing={false}
      moves={false}
      maximized={props.maximized ?? false}
      onToggleMaximize={props.onToggleMaximize ?? (() => {})}
      onReturn={props.onReturn ?? (() => {})}
    />,
  );
}

describe("surface tabs", () => {
  it("always shows the six fixed tabs, with Pull requests named in full", () => {
    pane();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label") ?? tab.textContent);
    expect(tabs).toEqual(["Diff", "Files", "Browser", "Activity", "Pull requests", "Side chat"]);
    expect(screen.getByRole("tab", { name: "Pull requests" })).toHaveTextContent("PRs");
    expect(screen.queryByRole("button", { name: /^Close (Files|Diff)/ })).not.toBeInTheDocument();
  });

  it("shows the first surface until another is chosen, and keeps the chosen one when its tab is pressed again", async () => {
    const user = userEvent.setup();
    pane();
    expect(screen.getByText("Diff content")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open a surface")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText("Files content")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText("Files content")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Pull requests" }));
    expect(screen.getByText("Linked pulls content")).toBeInTheDocument();
    expect(useUi.getState().panelTab).toBe("pulls");
  });

  it("keeps the layout controls: maximise and close", async () => {
    const user = userEvent.setup();
    const onReturn = vi.fn();
    const onToggleMaximize = vi.fn();
    pane({ onReturn, onToggleMaximize });
    await user.click(screen.getByRole("button", { name: "Maximise panel" }));
    expect(onToggleMaximize).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close side panel" }));
    expect(onReturn).toHaveBeenCalled();
  });

  it("is a full-screen sheet on the phone: Back to thread and Close, with nothing to maximise", () => {
    pane({ mode: "sheet" });
    expect(screen.getByRole("button", { name: "Back to thread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close side panel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Maximise panel" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(6);
  });

  it("keeps the tab row, with Maximise and Close at its right end, when it floats over the thread", () => {
    pane({ mode: "overlay" });
    expect(screen.queryByRole("button", { name: "Back to thread" })).not.toBeInTheDocument();
    const row = screen.getByRole("tablist").closest("header")!;
    const buttons = [...row.querySelectorAll("button:not([role=tab])")].map((button) => button.getAttribute("aria-label"));
    expect(buttons.slice(-2)).toEqual(["Maximise panel", "Close side panel"]);
  });

  it("heads the reading layout's drawer with Back to thread at the left and Maximise and Close at the right", async () => {
    const user = userEvent.setup();
    const onReturn = vi.fn();
    useUi.setState({ workspaceLayout: "reading" });
    try {
      pane({ onReturn });
      const row = screen.getByRole("button", { name: "Back to thread" }).closest("header")!;
      expect(row.nextElementSibling?.querySelector('[role="tablist"]')).not.toBeNull();
      expect(screen.getAllByRole("button", { name: "Close side panel" })).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: "Back to thread" }));
      expect(onReturn).toHaveBeenCalled();
    } finally {
      useUi.setState({ workspaceLayout: "console" });
    }
  });

  it("is one tablist: one Tab stop, arrow keys, Home and End, and a panel for the chosen tab only", async () => {
    const user = userEvent.setup();
    pane();
    const tabs = () => screen.getAllByRole("tab");
    expect(tabs().filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(tabs().filter((tab) => tab.tabIndex === 0)).toEqual([screen.getByRole("tab", { name: "Files" })]);
    expect(tabs().filter((tab) => tab.hasAttribute("aria-controls"))).toHaveLength(1);
    expect(document.getElementById("context-files")).not.toBeNull();
    screen.getByRole("tab", { name: "Files" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(useUi.getState().panelTab).toBe("browser");
    await user.keyboard("{End}");
    expect(useUi.getState().panelTab).toBe("side");
    await user.keyboard("{ArrowRight}");
    expect(useUi.getState().panelTab).toBe("diff");
    await user.keyboard("{ArrowLeft}");
    expect(useUi.getState().panelTab).toBe("side");
    await user.keyboard("{Home}");
    expect(useUi.getState().panelTab).toBe("diff");
  });

  it("has no plus while every tab is open", () => {
    pane();
    expect(screen.queryByRole("button", { name: "Open a tab" })).not.toBeInTheDocument();
  });

  it("lists closed surfaces under a plus at the end of the row, reopens one, and leaves Terminal and Reset tab order out", async () => {
    const user = userEvent.setup();
    useClosedTabs.setState({ closed: ["files", "side"] });
    pane();
    expect(screen.getAllByRole("tab").map((tab) => tab.id)).toEqual(["context-tab-diff", "context-tab-browser", "context-tab-activity", "context-tab-pulls"]);
    await user.click(screen.getByRole("button", { name: "Open a tab" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Files", "Side chat"]);
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    expect(useClosedTabs.getState().closed).toEqual(["side"]);
    expect(useUi.getState().panelTab).toBe("files");
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
  });
});

describe("connection states in the panel", () => {
  afterEach(() => useConnection.setState({ offline: false, serviceDown: false }));

  it("marks only the tabs that need the network when offline, and says so over their content", () => {
    useConnection.setState({ offline: true });
    useUi.setState({ panelTab: "pulls" });
    pane();
    const offline = screen.getAllByRole("tab").filter((tab) => tab.hasAttribute("data-offline"));
    expect(offline.map((tab) => tab.id)).toEqual(["context-tab-browser", "context-tab-pulls", "context-tab-side"]);
    expect(screen.getByText("You’re offline.")).toBeInTheDocument();
  });

  it("says Diff is waiting for the Orbyn service when it does not answer", () => {
    useConnection.setState({ serviceDown: true });
    useUi.setState({ panelTab: "diff" });
    pane();
    expect(screen.getByText("Waiting for the Orbyn service")).toBeInTheDocument();
    expect(screen.getByText("The diff comes back when the service does.")).toBeInTheDocument();
    expect(screen.queryByText("Diff content")).not.toBeInTheDocument();
  });

  it("names the maximise button Restore once the panel is maximised", () => {
    pane({ maximized: true });
    expect(screen.getByRole("button", { name: "Restore" })).toHaveAttribute("title", "Restore");
    expect(screen.queryByRole("button", { name: "Maximise panel" })).not.toBeInTheDocument();
  });

  it("tells each tab what is waiting while the service is away, and leaves the Browser usable", () => {
    useConnection.setState({ serviceDown: true });
    const lines: [RightTab, string][] = [
      ["files", "Files open again as soon as it is back."],
      ["activity", "Activity shows again as soon as it is back."],
      ["side", "Your side chats open again as soon as it is back. Nothing is lost."],
    ];
    for (const [tab, line] of lines) {
      useUi.setState({ panelTab: tab });
      const { unmount } = pane();
      expect(screen.getByText("Waiting for the Orbyn service")).toBeInTheDocument();
      expect(screen.getByText(line)).toBeInTheDocument();
      unmount();
    }
    useUi.setState({ panelTab: "browser" });
    pane();
    expect(screen.getByText("Browser content")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the Orbyn service")).not.toBeInTheDocument();
  });

  it("marks the Browser tab offline and leaves the note to the Browser, while Diff, Files and Activity carry no mark", () => {
    useConnection.setState({ offline: true });
    useUi.setState({ panelTab: "browser" });
    pane();
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("data-offline");
    for (const name of ["Diff", "Files", "Activity"]) expect(screen.getByRole("tab", { name })).not.toHaveAttribute("data-offline");
    expect(screen.getByText("Browser content")).toBeInTheDocument();
    expect(screen.queryByText("You’re offline.")).not.toBeInTheDocument();
  });

  it("folds tabs that don't fit into More, keeping the open tab visible", async () => {
    const user = userEvent.setup();
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tab" ? 50 : 24;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tablist" ? 174 : 0;
    });
    useUi.setState({ panelTab: "side" });
    pane();
    expect(screen.getAllByRole("tab").map((tab) => tab.id)).toEqual(["context-tab-diff", "context-tab-files", "context-tab-side"]);
    await user.click(screen.getByRole("button", { name: "More tabs" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Browser", "Activity", "PRs"]);
    await user.click(screen.getByRole("menuitem", { name: "Browser" }));
    expect(useUi.getState().panelTab).toBe("browser");
    width.mockRestore();
    client.mockRestore();
  });
});
