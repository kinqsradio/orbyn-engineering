import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { installMockFetch, setViewportWidth } from "../test-support";
import { useUi } from "../state/ui";
import { App } from "./App";

beforeEach(() => {
  installMockFetch();
  useUi.getState().setPrefs({ welcomeDone: true });
  useUi.setState({ panelOpen: false, terminalOpen: false, detailsOpen: true, workspaceLayout: "console" });
  window.location.hash = "#/threads/t-done";
});

const wait = { timeout: 8000 };
const details = () => screen.findByRole("button", { name: "Details" }, wait);
const card = () => screen.queryByRole("complementary", { name: "Thread details" });
const panel = () => screen.queryByRole("complementary", { name: "Thread context" });

describe("the Details button and the details card", () => {
  it("is a button with icon and label, left of Terminal and Show side panel, pressed while the card shows", async () => {
    setViewportWidth(1400);
    const user = userEvent.setup();
    render(<App />);
    const button = await details();
    const terminal = screen.getByRole("button", { name: "Terminal" });
    const side = screen.getByRole("button", { name: "Show side panel" });
    expect(button).toHaveTextContent("Details");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(terminal.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(card()).toBeInTheDocument();
  });

  it("opens as a popover under the button while the panel is closed, and Escape closes it and returns focus", async () => {
    setViewportWidth(1400);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const button = await details();
    await user.click(button);
    expect(container.querySelector(".details-popover")).toContainElement(card());
    expect(panel()).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(card()).toBeNull());
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("closes the popover on a press outside it", async () => {
    setViewportWidth(1400);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await details());
    expect(card()).toBeInTheDocument();
    await user.click(screen.getByRole("heading", { level: 1 }));
    await waitFor(() => expect(card()).toBeNull());
  });

  it("sits at the top of the side panel, above its tabs, while the panel is open", async () => {
    setViewportWidth(1400);
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Show side panel" }, wait));
    const inside = panel()!;
    expect(inside).toContainElement(card());
    const tabs = screen.getByRole("tablist", { name: "Context" });
    expect(card()!.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".details-popover")).toBeNull();
    // The same button hides and shows it there.
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(card()).toBeNull();
  });

  it("sits at the top of the overlay panel on a medium window", async () => {
    setViewportWidth(1000);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Show side panel" }, wait));
    expect(panel()).toHaveAttribute("data-mode", "overlay");
    expect(panel()).toContainElement(card());
  });

  it("is a rail beside the thread in Ledger on a wide window", async () => {
    setViewportWidth(1400);
    useUi.setState({ workspaceLayout: "ledger" });
    const { container } = render(<App />);
    await details();
    await waitFor(() => expect(container.querySelector(".thread-main > .details")).not.toBeNull());
    expect(panel()).toBeNull();
  });
});
