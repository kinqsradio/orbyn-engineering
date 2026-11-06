import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../../api/types";
import { useUi } from "../../state/ui";
import { SurfacePane } from "./SurfacePane";

vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => <div>Browser content</div> }));
vi.mock("./DiffPanel", () => ({ DiffPanel: () => <div>Diff content</div> }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => <div>Files content</div> }));
vi.mock("./ActivityPanel", () => ({ ActivityPanel: () => null }));
vi.mock("./LinkedPulls", () => ({ LinkedPulls: () => <div>Linked pulls content</div> }));
vi.mock("./SideChatPane", () => ({ SideChatPane: () => <div>Side chat content</div> }));
vi.mock("./sideChat", () => ({ openSideChat: vi.fn(), closeSideChat: vi.fn() }));

const thread = { id: "thread-1" } as Thread;

beforeEach(() => {
  useUi.setState({ panelOpen: true, panelTab: null, terminalOpen: false, pullReveal: null });
});

function pane(props: { overlay?: boolean; onReturn?: () => void; onToggleMaximize?: () => void; maximized?: boolean } = {}) {
  return render(
    <SurfacePane
      thread={thread}
      overlay={props.overlay ?? false}
      closing={false}
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

  it("opens a surface from its tab and its list when selected again", async () => {
    const user = userEvent.setup();
    pane();
    expect(screen.getByLabelText("Open a surface")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText("Files content")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.queryByText("Files content")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Open a surface")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Pull requests" }));
    expect(screen.getByText("Linked pulls content")).toBeInTheDocument();
    expect(useUi.getState().panelTab).toBe("pulls");
  });

  it("keeps the layout controls: maximize, terminal and close", async () => {
    const user = userEvent.setup();
    const onReturn = vi.fn();
    const onToggleMaximize = vi.fn();
    pane({ onReturn, onToggleMaximize });
    await user.click(screen.getByRole("button", { name: "Maximize pane" }));
    expect(onToggleMaximize).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(useUi.getState().terminalOpen).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close surfaces" }));
    expect(onReturn).toHaveBeenCalled();
  });

  it("offers Back to thread instead of maximize when it covers the thread", () => {
    pane({ overlay: true });
    expect(screen.getByRole("button", { name: "Back to thread" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Maximize pane" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(6);
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

  it("reaches the launcher again from the chosen tab, and Escape returns to it", async () => {
    const user = userEvent.setup();
    pane();
    expect(screen.queryByRole("button", { name: "All surfaces" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-description", "Opens all surfaces");
    expect(screen.getByRole("tab", { name: "Diff" })).not.toHaveAttribute("aria-description");
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(useUi.getState().panelTab).toBeNull();
    expect(screen.getByLabelText("Open a surface")).toHaveFocus();
    expect(screen.getByRole("button", { name: /Browser/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(useUi.getState().panelTab).toBe("files");
    screen.getByRole("tab", { name: "Files" }).focus();
    await user.keyboard("{Enter}");
    expect(useUi.getState().panelTab).toBeNull();
  });

  it("opens a surface with its launcher shortcut", async () => {
    const user = userEvent.setup();
    pane();
    screen.getByLabelText("Open a surface").focus();
    await user.keyboard("f");
    expect(screen.getByText("Files content")).toBeInTheDocument();
  });
});
