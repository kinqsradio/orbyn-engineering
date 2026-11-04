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
vi.mock("./SideChatPane", () => ({ SideChatPane: () => null }));
vi.mock("./sideChat", () => ({ openSideChat: vi.fn(), closeSideChat: vi.fn() }));

const thread = { id: "thread-1" } as Thread;

beforeEach(() => {
  useUi.setState({ panelOpen: true, panelTab: null, openSurfaces: [], terminalOpen: false });
});

function pane() {
  return render(<SurfacePane thread={thread} overlay={false} closing={false} maximized={false} onToggleMaximize={() => {}} onReturn={() => {}} />);
}

describe("surface menu", () => {
  it("opens a surface, retains it when selected again, and closes its tab", async () => {
    const user = userEvent.setup();
    pane();
    await user.click(screen.getByRole("button", { name: "New surface" }));
    expect(screen.getByRole("menuitem", { name: "Device" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Pull request" })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    expect(screen.getByText("Files content")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New surface" }));
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    expect(screen.getByText("Files content")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close Files" }));
    expect(screen.queryByRole("tab", { name: "Files" })).not.toBeInTheDocument();
  });

  it("supports keyboard dismissal and opens the terminal drawer", async () => {
    const user = userEvent.setup();
    pane();
    const trigger = screen.getByRole("button", { name: "New surface" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "New surface" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    expect(useUi.getState().terminalOpen).toBe(true);
  });
});
