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
  useUi.setState({ panelOpen: true, panelTab: null, openSurfaces: [], terminalOpen: false, pullReveal: null });
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

  it("opens a surface from its tab and keeps it when selected again", async () => {
    const user = userEvent.setup();
    pane();
    expect(screen.getByLabelText("Open a surface")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText("Files content")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText("Files content")).toBeInTheDocument();
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

  it("opens a surface with its launcher shortcut", async () => {
    const user = userEvent.setup();
    pane();
    screen.getByLabelText("Open a surface").focus();
    await user.keyboard("f");
    expect(screen.getByText("Files content")).toBeInTheDocument();
  });
});
