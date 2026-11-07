import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { installMockFetch, setViewportWidth } from "../test-support";
import { useUi } from "../state/ui";
import { App } from "./App";
import { useSidebarDrawer } from "./sidebarDrawer";

beforeEach(() => {
  installMockFetch();
  useUi.getState().setPrefs({ welcomeDone: true });
  useUi.setState({ panelOpen: false, terminalOpen: false });
  useSidebarDrawer.setState({ open: false });
  window.location.hash = "#/threads/t-done";
});

const panel = () => screen.queryByRole("complementary", { name: "Thread context" });
const sidebar = () => screen.queryByRole("navigation", { name: "Workspace" });
const thread = () => document.querySelector(".thread-main") as HTMLElement | null;
// The first render of the whole app can take longer than the default wait on a busy machine.
const showPanel = () => screen.findByRole("button", { name: "Show side panel" }, { timeout: 8000 });

describe("layouts by window width", () => {
  it("docks the sidebar, the thread and the panel from 1160 px", async () => {
    setViewportWidth(1160);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await showPanel());
    expect(sidebar()).toBeInTheDocument();
    expect(panel()).toHaveAttribute("data-mode", "docked");
    expect(thread()).not.toHaveAttribute("hidden");
  });

  it("keeps the sidebar docked from 900 to 1159 px and floats the panel over the thread", async () => {
    setViewportWidth(1159);
    const user = userEvent.setup();
    render(<App />);
    const button = await showPanel();
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(sidebar()).toBeInTheDocument();
    expect(panel()).toHaveAttribute("data-mode", "overlay");
    // Non-modal: the thread stays where it was, mounted and not hidden.
    expect(thread()).not.toHaveAttribute("hidden");
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the overlay with Escape and returns focus to the header button, or with the button itself", async () => {
    setViewportWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    const button = await showPanel();
    await user.click(button);
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(panel()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(useUi.getState().panelOpen).toBe(false));
    expect(button).toHaveFocus();
    await user.click(button);
    expect(useUi.getState().panelOpen).toBe(true);
    await user.click(button);
    expect(useUi.getState().panelOpen).toBe(false);
  });

  it("folds the sidebar into a drawer from 600 to 899 px, opened from the title bar over a scrim", async () => {
    setViewportWidth(899);
    const user = userEvent.setup();
    const { container } = render(<App />);
    await showPanel();
    expect(sidebar()).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show sidebar" });
    await user.click(toggle);
    expect(sidebar()).toBeInTheDocument();
    expect(container.querySelector(".drawer-scrim")).not.toBeNull();
    expect(container.querySelector(".shell")).toHaveAttribute("data-drawer", "open");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(sidebar()).not.toBeInTheDocument());
    expect(toggle).toHaveFocus();
  });

  it("closes the drawer on the scrim and on choosing a thread", async () => {
    setViewportWidth(720);
    const user = userEvent.setup();
    const { container } = render(<App />);
    await showPanel();
    await user.click(screen.getByRole("button", { name: "Show sidebar" }));
    await user.click(container.querySelector(".drawer-scrim")!);
    expect(sidebar()).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show sidebar" }));
    const row = await within(sidebar()!).findByText("Upgrade tokio and fix the fallout");
    await user.click(row);
    await waitFor(() => expect(sidebar()).not.toBeInTheDocument());
    expect(window.location.hash).not.toBe("#/threads/t-done");
  });

  it("opens the drawer or the panel, never both", async () => {
    setViewportWidth(800);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await showPanel());
    expect(panel()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(sidebar()).toBeInTheDocument();
    expect(useUi.getState().panelOpen).toBe(false);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(sidebar()).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Show side panel" }));
    expect(useUi.getState().panelOpen).toBe(true);
    await user.click(screen.getByRole("button", { name: "Show side panel" }));
    act(() => useSidebarDrawer.getState().setOpen(true));
    await user.click(screen.getByRole("button", { name: "Show side panel" }));
    expect(useUi.getState().panelOpen).toBe(true);
    expect(useSidebarDrawer.getState().open).toBe(false);
  });

  it("is the phone layout under 600 px: the panel is a sheet that replaces the thread", async () => {
    setViewportWidth(599);
    useUi.setState({ layoutKey: "t-done", panelOpen: true, panelTab: "files" });
    render(<App />);
    await screen.findByRole("button", { name: "Back to thread" }, { timeout: 8000 });
    expect(panel()).toHaveAttribute("data-mode", "sheet");
    expect(thread()).toHaveAttribute("hidden");
    expect(screen.queryByRole("button", { name: "Show side panel" })).not.toBeInTheDocument();
  });
});
