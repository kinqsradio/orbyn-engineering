import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockApi } from "../../../mock/api";
import { App } from "../../app/App";
import { runHandlers } from "../../app/shortcuts";
import { installMockFetch } from "../../test-support";
import { useUi } from "../../state/ui";

/**
 * Parity row K41. Each test presses the real chord at the document and lets the shell's
 * dispatcher find the command, so a missing rule, a wrong `when` or a dead handler fails.
 * The default chords mirror crates/orbyn-core/src/settings/keybindings.rs; the effort step commands
 * have no default chord, so they are bound the way a person's keybindings file would.
 */
const DEFAULTS = [
  ["mod+shift+m", "modelPicker.toggle"],
  ["mod+shift+e", "composer.effort"],
  ["mod+shift+a", "composer.mode"],
  ["mod+shift+g", "composer.branch"],
  ["mod+shift+x", "composer.workspace"],
  ["mod+shift+l", "composer.previousWorktree"],
  ["mod+s", "composer.stash"],
  ["mod+shift+y", "composer.increaseEffort"],
  ["mod+shift+u", "composer.decreaseEffort"],
].map(([key, command]) => ({ key, command, when: "!terminalFocus", remove: false }));

vi.setConfig({ testTimeout: 20_000 });

let mock: MockApi;

beforeEach(() => {
  mock = installMockFetch();
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    input === "/api/keybindings"
      ? Promise.resolve(new Response(JSON.stringify({ path: "keybindings.json", rules: DEFAULTS, issues: [] })))
      : inner(input, init),
  );
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  useUi.setState({ drafts: {}, stashes: {} });
});

const go = (hash: string) => {
  window.location.hash = hash;
};
const chord = (user: ReturnType<typeof userEvent.setup>, key: string, shift = true) =>
  user.keyboard(`{Control>}${shift ? "{Shift>}" : ""}${key}${shift ? "{/Shift}" : ""}{/Control}`);
const effortLabel = () => screen.getByRole("button", { name: /^Effort:/ }).getAttribute("aria-label");

async function openThread(id: string) {
  go(`#/threads/${id}`);
  render(<App />);
  const box = await screen.findByRole("textbox", { name: /^Message/ });
  await screen.findByRole("button", { name: /^Effort:/ });
  // The dispatcher needs the keymap, which loads asynchronously.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return box;
}

describe("composer menu shortcuts (K41)", () => {
  it("modelPicker.toggle opens the model picker", async () => {
    const user = userEvent.setup();
    await openThread("t-done");
    await chord(user, "m");
    expect(await screen.findByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
  });

  it("composer.effort opens the effort menu", async () => {
    const user = userEvent.setup();
    await openThread("t-done");
    await chord(user, "e");
    const menu = await screen.findByRole("menu", { name: "Composer options" });
    expect(within(menu).getByRole("menuitemradio", { name: /Medium/ })).toBeInTheDocument();
  });

  it("composer.mode opens the permission menu", async () => {
    const user = userEvent.setup();
    await openThread("t-done");
    await chord(user, "a");
    const menu = await screen.findByRole("menu", { name: "Composer options" });
    expect(within(menu).getByRole("menuitemradio", { name: /Supervised/ })).toBeInTheDocument();
  });

  it("composer.increaseEffort and decreaseEffort step and wrap at both ends", async () => {
    const user = userEvent.setup();
    await openThread("t-done");
    expect(effortLabel()).toContain("Effort: Medium");
    const press = async (key: string, shown: string) => {
      await chord(user, key);
      await waitFor(() => expect(effortLabel()).toContain(`Effort: ${shown}`));
    };
    await press("y", "High");
    await press("y", "Low"); // up from the top wraps to the bottom
    await press("u", "High"); // down from the bottom wraps to the top
    await press("u", "Medium");
    expect(mock.threads.find((t) => t.id === "t-done")?.effort).toBe("medium");
  });

  it("composer.focus puts the caret in the composer", async () => {
    const box = await openThread("t-done");
    box.blur();
    expect(box).not.toHaveFocus();
    act(() => void runHandlers("composer.focus"));
    expect(box).toHaveFocus();
  });

  it("composer.stash stashes the draft, then restores it", async () => {
    const user = userEvent.setup();
    const box = await openThread("t-done");
    await user.type(box, "keep this for later");
    await chord(user, "s", false);
    await waitFor(() => expect(box).toHaveValue(""));
    expect(useUi.getState().stashes["t-done"]?.map((entry) => entry.text)).toEqual(["keep this for later"]);
    await chord(user, "s", false);
    await waitFor(() => expect(box).toHaveValue("keep this for later"));
    expect(useUi.getState().stashes["t-done"] ?? []).toEqual([]);
  });

  it("composer.branch opens the branch switcher", async () => {
    const user = userEvent.setup();
    for (const thread of mock.threads) thread.active_run = null;
    go("#/threads/t-approval");
    render(<App />);
    await screen.findByRole("button", { name: /^Branch / });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await chord(user, "g");
    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    expect(within(dialog).getByRole("list", { name: "Branches" })).toBeInTheDocument();
  });

  it("the branch switcher follows the footerless design: Find a branch, a Current note and the switch hint", async () => {
    const user = userEvent.setup();
    for (const thread of mock.threads) thread.active_run = null;
    go("#/threads/t-approval");
    render(<App />);
    await screen.findByRole("button", { name: /^Branch / });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await chord(user, "g");
    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    expect(within(dialog).getByRole("textbox", { name: "Search branches" })).toHaveAttribute("placeholder", "Find a branch");
    expect(await within(dialog).findByText("Current")).toBeInTheDocument();
    expect(within(dialog).getByText("Choosing a branch switches to it.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  describe("on the draft", () => {
    const openDraft = async () => {
      go("#/");
      render(<App />);
      await screen.findByRole("heading", { name: /What should we build in/ });
      await screen.findByRole("button", { name: "Current checkout" });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    };

    it("composer.workspace opens the checkout menu", async () => {
      const user = userEvent.setup();
      await openDraft();
      await chord(user, "x");
      const menu = await screen.findByRole("menu");
      expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(0);
    });

    it("composer.previousWorktree reuses the latest worktree", async () => {
      const user = userEvent.setup();
      await openDraft();
      await chord(user, "l");
      expect(await screen.findByRole("button", { name: "This worktree" })).toBeInTheDocument();
    });
  });
});
