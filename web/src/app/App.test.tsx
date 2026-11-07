import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockApi } from "../../mock/api";
import { installMockFetch, setViewportWidth } from "../test-support";
import { useUi } from "../state/ui";
import { App } from "./App";

let mock: MockApi;

beforeEach(() => {
  mock = installMockFetch();
  useUi.setState({ projectFolders: true });
  useUi.getState().setPrefs({ welcomeDone: true });
});

const go = (hash: string) => {
  window.location.hash = hash;
};

describe("App against the mock API", () => {
  it("opens on the draft, with approvals shown as thread status", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    expect(await screen.findByRole("heading", { name: /What should we build in/ })).toBeInTheDocument();
    expect((await within(nav).findAllByText("Approval")).length).toBe(2);
    expect(within(nav).queryByRole("link", { name: /Approvals/ })).toBeNull();
  });

  it("marks the whole title bar strip as the window drag region", async () => {
    const { container } = render(<App />);
    await screen.findByRole("navigation", { name: "Workspace" });
    const bar = container.querySelector(".titlebar");
    expect(bar).toHaveAttribute("data-tauri-drag-region");
    expect(bar?.querySelector(".titlebar-drag")).toHaveAttribute("data-tauri-drag-region");
  });

  it("heads a thread with Terminal then Show side panel, each pressed while its panel is open", async () => {
    const user = userEvent.setup();
    useUi.setState({ panelOpen: false, terminalOpen: false });
    go("#/threads/t-approval");
    render(<App />);
    const terminal = await screen.findByRole("button", { name: "Terminal" });
    const side = screen.getByRole("button", { name: "Show side panel" });
    expect(terminal.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(side).toHaveAttribute("aria-pressed", "false");
    expect(terminal).toHaveAttribute("aria-pressed", "false");
    await user.click(terminal);
    expect(useUi.getState().terminalOpen).toBe(true);
    expect(terminal).toHaveAttribute("aria-pressed", "true");
    // The terminal is the bottom drawer: it is no tab of the side panel.
    expect(side).toHaveAttribute("aria-pressed", "false");
    await user.click(side);
    expect(useUi.getState().panelOpen).toBe(true);
    expect(side).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("tablist", { name: "Context" })).queryByRole("tab", { name: "Terminal" })).not.toBeInTheDocument();
  });

  it("creates the thread on first send from the draft", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole("textbox", { name: "Message" }), "start here{Enter}");
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/threads\/t-/));
    expect(await screen.findByText("start here")).toBeInTheDocument();
  });

  it("picks project and engine from the draft", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Claude Sonnet" }));
    const picker = await screen.findByRole("dialog", { name: "Choose a model" });
    expect(within(picker).getByRole("button", { name: /Aider \(terminal\) \(Unmanaged\)/ })).toBeInTheDocument();
    expect(within(picker).queryByRole("button", { name: /Cursor Agent/ })).toBeNull();
    await user.click(within(picker).getByRole("option", { name: /Claude Opus/ }));
    expect(await screen.findByRole("button", { name: "Claude Opus" })).toBeInTheDocument();
  });

  it("labels an unmanaged engine in the sidebar", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    expect(await within(nav).findByText("Unmanaged")).toBeInTheDocument();
  });

  it("marks a project with no chosen icon by a colour swatch, with its collapse chevron at the left", async () => {
    const { container } = render(<App />);
    await screen.findByRole("navigation", { name: "Workspace" });
    await waitFor(() => expect(container.querySelector(".folder-toggle .project-swatch")).not.toBeNull());
    expect(container.querySelector(".folder-toggle .folder-chev")).not.toBeNull();
    // A small plus at the row's right starts a thread there; its tooltip names the project.
    const plus = container.querySelector<HTMLAnchorElement>(".folder-head > .folder-new")!;
    expect(plus.title).toMatch(/^New thread in /);
    expect(plus.textContent).toBe("");
  });

  it("pins Working open and keeps Settled collapsed behind a count", async () => {
    const user = userEvent.setup();
    for (const thread of mock.threads.slice(10)) {
      thread.lifecycle = { ...thread.lifecycle!, settled_at: "2026-10-30T10:00:00Z" };
    }
    const running = mock.threads.find((thread) => thread.active_run)!;
    running.active_run = { ...running.active_run!, state: "running" };
    render(<App />);
    const settled = await screen.findByRole("button", { name: /^Settled/ });
    expect(settled).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByRole("button", { name: /^Working/ })).toHaveAttribute("aria-expanded", "true");
    await user.click(settled);
    expect(settled).toHaveAttribute("aria-expanded", "true");
  });

  it("searches threads from the sidebar", async () => {
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    await within(nav).findByText("Upgrade tokio and fix the fallout");
    await user.click(within(nav).getByRole("button", { name: "Search threads" }));
    await user.type(within(nav).getByRole("searchbox", { name: "Search threads" }), "tokio");
    expect(within(nav).queryByText("Explain how the event log resumes")).toBeNull();
    expect(within(nav).getByText("Upgrade tokio and fix the fallout")).toBeInTheDocument();
  });

  it("renames a thread in a dialog: F2 opens it, Enter saves, Escape cancels", async () => {
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    const title = "Upgrade tokio and fix the fallout";
    const row = (await within(nav).findByText(title)).closest("a")!;
    row.focus();
    await user.keyboard("{F2}");
    const dialog = await screen.findByRole("dialog", { name: "Rename thread" });
    expect(within(dialog).getByRole("textbox", { name: "Thread title" })).toHaveValue(title);
    // The browser turns Escape into the dialog's cancel event; jsdom does not.
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename thread" })).toBeNull());
    expect(within(nav).getByText(title)).toBeInTheDocument();

    row.focus();
    await user.keyboard("{F2}");
    const again = await screen.findByRole("dialog", { name: "Rename thread" });
    await user.clear(within(again).getByRole("textbox", { name: "Thread title" }));
    await user.type(within(again).getByRole("textbox", { name: "Thread title" }), "Tokio upgrade{Enter}");
    expect(await within(nav).findByText("Tokio upgrade")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Rename thread" })).toBeNull();
  });

  describe("updates", () => {
    const idle = () => {
      for (const thread of mock.threads) thread.active_run = null;
    };
    const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole("button", { name: "Updates available · 3" }));
      return screen.findByRole("dialog", { name: "Update everything" });
    };

    it("shows the button only when something is available", async () => {
      mock.patchUpdates({
        engines: [],
        library: { ...mock.updates.library, behind: 0, incoming: [] },
        app: { ...mock.updates.app, latest: mock.updates.app.current },
      });
      render(<App />);
      await screen.findByRole("navigation", { name: "Workspace" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole("button", { name: /updates? available/ })).toBeNull();
    });

    it("lists each item with its versions and kind, and disables with the reason", async () => {
      const user = userEvent.setup();
      render(<App />);
      const dialog = await openDialog(user);
      expect(within(dialog).getByText("Claude Code")).toBeInTheDocument();
      expect(within(dialog).getByText("2.1.14 → 2.1.20")).toBeInTheDocument();
      expect(within(dialog).getByText("Restarts the app")).toBeInTheDocument();
      expect(within(dialog).getByText("Skills library")).toBeInTheDocument();
      expect(within(dialog).getByText("8ede3c40 → a1b2c3d0")).toBeInTheDocument();
      expect(within(dialog).getByText("Library")).toBeInTheDocument();
      expect(within(dialog).getByText(/runs are active/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Update everything" })).toBeDisabled();
    });

    it("expands What's new for rows with an update: app notes and the incoming library changes", async () => {
      const user = userEvent.setup();
      render(<App />);
      const dialog = await openDialog(user);
      const toggles = within(dialog).getAllByRole("button", { name: "What’s new" });
      expect(toggles).toHaveLength(2);
      await user.click(toggles[0]!);
      expect(within(dialog).getByText("Faster thread loading")).toBeInTheDocument();
      await user.click(within(dialog).getAllByRole("button", { name: "What’s new" })[1]!);
      expect(within(dialog).getByText(/\d+ new changes?/)).toBeInTheDocument();
    });

    it("keeps the Skills library row, saying it is up to date, when nothing newer exists", async () => {
      mock.patchUpdates({ library: { ...mock.updates.library, behind: 0, incoming: [] } });
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: /Updates available/ }));
      const dialog = await screen.findByRole("dialog", { name: "Update everything" });
      expect(within(dialog).getByText("8ede3c40 · Up to date")).toBeInTheDocument();
    });

    it("runs in order, stops at the first failure and retries", async () => {
      idle();
      mock.failUpdateStep("library");
      const user = userEvent.setup();
      render(<App />);
      const dialog = await openDialog(user);
      await user.click(within(dialog).getByRole("button", { name: "Update everything" }));
      expect(await within(dialog).findByText(/exited with status 1/, {}, { timeout: 3000 })).toBeInTheDocument();
      const steps = within(dialog).getByRole("list", { name: "Update progress" }).querySelectorAll("li");
      expect([...steps].map((step) => step.getAttribute("data-state"))).toEqual(["done", "failed", "pending"]);
      await user.click(within(dialog).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(mock.updates.app.current).toBe("0.2.0"), { timeout: 3000 });
    });

    it("shows manual instructions and no button in server mode", async () => {
      mock.patchUpdates({
        app: {
          ...mock.updates.app,
          mode: "server",
          can_apply: false,
          blocked_reason: "Replace the orbynd binary and restart.",
        },
      });
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "Updates available · 2" }));
      const dialog = await screen.findByRole("dialog", { name: "Update everything" });
      expect(within(dialog).getByText(/Replace the orbynd binary/)).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Update everything" })).toBeDisabled();
    });

    it("checks from Settings without applying anything", async () => {
      const user = userEvent.setup();
      go("#/settings/maintenance");
      render(<App />);
      const before = mock.updates.checked_at;
      await user.click(await screen.findByRole("button", { name: "Check for updates" }));
      await waitFor(() => expect(mock.updates.checked_at).not.toBe(before));
      expect(mock.updates.engines[0]?.current).toBe("2.1.14");
      const background = screen.getByRole("switch", { name: "Background checks" });
      await waitFor(() => expect(background).toBeEnabled());
      await user.click(background);
      await waitFor(() => expect(background).not.toBeChecked());
    });

    it("says when updates aren't set up for this build", async () => {
      mock.patchUpdates({ app: { ...mock.updates.app, latest: null, unconfigured: true } });
      go("#/settings/maintenance");
      render(<App />);
      expect(await screen.findByText("Updates aren't set up for this build.")).toBeInTheDocument();
    });
  });

  it("walks a new person from empty state to a thread", async () => {
    mock.reset("empty");
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Add your first project" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a folder" }));
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const field = await within(palette).findByLabelText("Folder path");
    // Typed straight after the starting ~/, an absolute path replaces it.
    await user.type(field, "/Users/dev/code/payments-service{Enter}");

    expect(await screen.findByRole("heading", { name: /^Trust .+\?$/ })).toBeInTheDocument();
    expect(screen.getByText(/Only trust folders you know/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trust folder" }));

    expect(await screen.findByRole("heading", { name: /What should we build in/ })).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox", { name: "Message" }), "go{Enter}");
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/threads\//));
  });

  const openAddProject = async (user: ReturnType<typeof userEvent.setup>) => {
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    await user.click(await within(nav).findByRole("button", { name: "Add project" }));
    return screen.findByRole("dialog", { name: "Command palette" });
  };

  it("clones from a URL and keeps the URL on failure", async () => {
    mock.fail("/api/clones", 1, 502, "clone_failed", "The remote refused.");
    const user = userEvent.setup();
    render(<App />);
    const palette = await openAddProject(user);
    await user.click(within(palette).getByRole("button", { name: /Clone a repository/ }));
    const dialog = await screen.findByRole("dialog", { name: "Clone a repository" });
    const field = within(dialog).getByLabelText("Git URL or owner/name");
    await user.type(field, "https://example.com/team/repo.git{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The remote refused.");
    expect(field).toHaveValue("https://example.com/team/repo.git");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: /^Trust .+\?$/ }, { timeout: 3000 })).toBeInTheDocument();
  });

  it("creates a new project", async () => {
    const user = userEvent.setup();
    render(<App />);
    const palette = await openAddProject(user);
    await user.click(within(palette).getByRole("button", { name: /New project/ }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.type(within(dialog).getByLabelText("Name"), "fresh-idea{Enter}");
    expect(await screen.findByRole("heading", { name: /What should we build in/ })).toBeInTheDocument();
  });

  it("adds a local folder where it is, then asks for trust", async () => {
    const user = userEvent.setup();
    render(<App />);
    const palette = await openAddProject(user);
    const field = await within(palette).findByLabelText("Folder path");
    await user.clear(field);
    await user.type(field, "/Users/dev/code/site/{Enter}");
    expect(await screen.findByRole("heading", { name: /^Trust .+\?$/ })).toBeInTheDocument();
  });

  it("opens the welcome steps alone on a new device, without the empty home beneath", async () => {
    mock.reset("first-run");
    useUi.getState().setPrefs({ welcomeDone: false });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Welcome to Orbyn Engineering" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add your first project" })).toBeNull();
  });

  it("opens straight on the draft flow, with nothing to set up", async () => {
    mock.reset("first-run");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Add your first project" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.queryByText(/set up/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Skill library settings" })).toBeNull();
  });

  it("says so quietly when skills are unavailable, and Settings can try again", async () => {
    mock.reset("no-skills");
    mock.failSetup();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Add your first project" })).toBeInTheDocument();
    await user.click(await screen.findByRole("link", { name: "Skill library settings" }));
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be reached/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull(), { timeout: 3000 });
    expect(screen.queryByRole("link", { name: "Skill library settings" })).toBeNull();
  });

  it("adopts another library from Settings", async () => {
    const user = userEvent.setup();
    go("#/settings/maintenance");
    render(<App />);
    await user.click(await screen.findByText("Advanced"));
    await user.click(await screen.findByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use this folder" })).toBeEnabled(), { timeout: 3000 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reviews incoming commits before updating the library", async () => {
    for (const thread of mock.threads) thread.active_run = null;
    const user = userEvent.setup();
    go("#/settings/maintenance");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Review update" }));
    const dialog = await screen.findByRole("dialog", { name: "Update the library?" });
    expect(within(dialog).getByText("Add statechart review guidance")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    expect(await screen.findByText("The library is up to date.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review update" })).toBeDisabled();
  });

  it("disables library updates while runs are active", async () => {
    go("#/settings/maintenance");
    render(<App />);
    expect(await screen.findByText(/runs are active/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review update" })).toBeDisabled();
  });

  it("disables library changes with the reason", async () => {
    mock.patchWorkspace({
      library: { ...mock.workspace.library!, dirty: true, dirty_files: ["skills/a.md"] },
    });
    go("#/settings/maintenance");
    render(<App />);
    expect(await screen.findByText(/local changes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review update" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
  });

  it("keeps a failed unregister visible and retries without offering file deletion", async () => {
    const user = userEvent.setup();
    go("#/settings/projects?project=mock%3Ap-site");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Remove…" }));
    const dialog = await screen.findByRole("dialog", { name: /Remove.*marketing-site/ });
    expect(within(dialog).getByText("Orbyn stops tracking this project. Files on disk are not touched.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    const confirm = within(dialog).getByRole("button", { name: "Remove project" });
    mock.fail("/api/projects/p-site", 1, 409, "thread_busy", "One of this project's threads is running.");
    await user.click(confirm);
    expect(await within(dialog).findByText(/threads is running/)).toBeInTheDocument();
    for (const thread of mock.threads) if (thread.project_id === "p-site") thread.active_run = null;
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Remove.*marketing-site/ })).toBeNull());
    expect(await screen.findByText("Choose a project to manage its name, icon, checkouts and actions.")).toBeInTheDocument();
  });

  it("shows the selected branch in the thread row's details", async () => {
    go("#/threads/t-approval");
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    const row = await within(nav).findByRole("link", { name: /Add approval timeout/ });
    expect(row).toHaveAccessibleDescription(/approval-timeout/);
  });

  it("offers sign-in when the service asks for it, then opens", async () => {
    mock.reset("remote");
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Access key"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't valid");
    await user.clear(screen.getByLabelText("Access key"));
    await user.type(screen.getByLabelText("Access key"), "orbyn-demo-key");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
  });

  it("offers retry when the service can't be reached", async () => {
    mock.reset("offline");
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("Can't reach Orbyn")).toBeInTheDocument();
    mock.reset("default");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
  });

  it("renders a thread's log, tool calls and pending approval", async () => {
    go("#/threads/t-approval");
    render(<App />);
    expect(await screen.findByText(/the engine hangs/)).toBeInTheDocument();
    expect(await screen.findByText(/Searched code for expire_open/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Plan" })).toBeInTheDocument();
    expect(await screen.findByRole("article", { name: "Run the core test suite" })).toBeInTheDocument();
    expect(document.querySelector(".thread-state")).toHaveTextContent("Approval");
  });

  it("streams a run to completion", async () => {
    const user = userEvent.setup();
    go("#/threads/t-empty");
    const view = render(<App />);
    try {
      const input = await screen.findByLabelText(/^Message/);
      await user.type(input, "go");
      vi.useFakeTimers();
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      // The mock emits one word per timer. Advance the script explicitly so
      // jsdom rendering speed cannot turn a working stream into a timeout.
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(screen.getByText("scripted reply")).toBeInTheDocument();
      expect(document.querySelector(".thread-state")).not.toHaveTextContent("Completed");
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(document.querySelector(".thread-state")).toHaveTextContent("Completed");
      expect(screen.getByText("go")).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("cancels a run and expires its approvals", async () => {
    const user = userEvent.setup();
    go("#/threads/t-site-approval");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByText("Run cancelled.")).toBeInTheDocument());
    expect(await screen.findByText("Expired")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".thread-state")).toHaveTextContent("Cancelled"));
  });

  it("sends a refused run to trust and comes back to the thread", async () => {
    const user = userEvent.setup();
    const { threads } = mock;
    expect(threads.length).toBeGreaterThan(0);
    const created = mock.handle("POST", "/api/threads", {
      project_id: "p-new",
      engine: "claude",
      title: "Untrusted",
    }).body as { id: string };
    go(`#/threads/${created.id}`);
    render(<App />);
    await user.type(await screen.findByLabelText(/^Message/), "go{Enter}");
    expect(await screen.findByRole("heading", { name: /^Trust .+\?$/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trust folder" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/threads/${created.id}`));
    expect(await screen.findByLabelText(/^Message/)).toHaveValue("go");
  });

  it("recovers an Engines failure with retry", async () => {
    mock.fail("/api/engines", 1);
    const user = userEvent.setup();
    go("#/settings/providers");
    render(<App />);
    expect(await screen.findByText("Couldn't load providers")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Claude Code" })).toBeInTheDocument();
  });

  it("confirms an engine update and refuses during an active run", async () => {
    const user = userEvent.setup();
    go("#/settings/providers");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Claude Code" }));
    await user.click(await screen.findByRole("button", { name: "Update to 2.1.20" }));
    const dialog = await screen.findByRole("dialog", { name: "Update Claude Code?" });
    expect(within(dialog).getByText("npm install -g @anthropic-ai/claude-code")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("active run");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("never asks for an engine credential", async () => {
    const user = userEvent.setup();
    go("#/settings/providers");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Codex" }));
    await screen.findByRole("heading", { name: "Codex" });
    expect(screen.getByRole("button", { name: "Copy sign-in command" })).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/api key|paste your token/i);
  });

  it("shows the thread details with real data only", async () => {
    go("#/threads/t-approval");
    window.matchMedia = ((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    render(<App />);
    const details = await screen.findByRole("complementary", { name: "Thread details" });
    await waitFor(() => expect(details).toHaveTextContent("+42 -3"));
    expect(within(details).getByText("approval-timeout")).toBeInTheDocument();
    expect(within(details).queryByText("Commit")).toBeNull();
    expect(within(details).queryByText(/Open in editor/)).toBeNull();
  });

  it("opens the command palette and goes to a result", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText("Upgrade tokio and fix the fallout");
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await user.type(within(palette).getByRole("combobox"), "tokio{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/threads/t-failed"));
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("opens the file picker while saved keybindings are still loading", async () => {
    const user = userEvent.setup();
    const fetch = globalThis.fetch;
    let releaseKeybindings = () => {};
    const keybindingsReady = new Promise<void>((resolve) => { releaseKeybindings = resolve; });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input === "/api/keybindings") await keybindingsReady;
      return fetch(input, init);
    });
    try {
      go("#/threads/t-done");
      render(<App />);
      await screen.findByRole("textbox", { name: /^Message/ });
      await user.keyboard("{Control>}p{/Control}");
      const palette = await screen.findByRole("dialog", { name: "Command palette" });
      expect(within(palette).getByRole("combobox", { name: "Search" })).toHaveAttribute("placeholder", "Go to file");
    } finally {
      await act(async () => { releaseKeybindings(); });
    }
  });

  it("settles a thread from its menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    const row = (await within(nav).findByText("Explain how the event log resumes")).closest("a");
    fireEvent.contextMenu(row as HTMLElement);
    await user.click(await screen.findByRole("menuitem", { name: "Settle thread" }));
    await waitFor(() => expect(mock.threads.find((t) => t.id === "t-done")?.lifecycle?.settled_at).not.toBeNull());
  });

  it("shows a hover card for a row after the delay", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    const row = (await within(nav).findByText("Explain how the event log resumes")).closest("a") as HTMLElement;
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    const card = await screen.findByRole("tooltip");
    expect(card).toHaveTextContent("Claude Code, claude-opus-5-5");
    fireEvent.pointerLeave(row);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("opens the panel on its first tab, with no launcher, when the window is wide enough to open it itself", async () => {
    setViewportWidth(1700);
    go("#/threads/t-done");
    render(<App />);
    const row = await screen.findByRole("tablist", { name: "Context" });
    expect(within(row).getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByLabelText("Open a surface")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open a tab" })).toBeNull();
  });

  it("opens an empty thread as a draft, with the project in the heading", async () => {
    go("#/threads/t-empty");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "What should we build in marketing-site?" })).toBeInTheDocument();
    expect(screen.getByText("Current checkout")).toBeInTheDocument();
  });

  it("sets the panel animation duration from Appearance", async () => {
    go("#/settings/appearance");
    render(<App />);
    const slider = await screen.findByRole("spinbutton", { name: /Panel animations/ });
    expect(slider).toHaveValue(300);
    fireEvent.change(slider, { target: { value: "240" } });
    expect(localStorage.getItem("orbyn.prefs.v1")).toContain('"panelAnimationMs":240');
  });

  it("switches and remembers the theme", async () => {
    const user = userEvent.setup();
    go("#/settings/appearance");
    render(<App />);
    const theme = await screen.findByRole("radiogroup", { name: "Theme" });
    expect(within(theme).getByRole("radio", { name: "Dark" })).toBeChecked();
    await user.click(within(theme).getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("orbyn.prefs.v1")).toContain('"theme":"light"');
    await user.click(within(theme).getByRole("radio", { name: "Dim" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.preset).toBe("dim");
    expect(within(theme).getByRole("radio", { name: "Dim" })).toBeChecked();
    await user.click(within(theme).getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.preset).toBeUndefined();
  });

  it("keeps the page behind settings mounted but hidden", async () => {
    go("#/settings/appearance");
    const { container } = render(<App />);
    await screen.findByRole("region", { name: "Settings" });
    const behind = container.querySelector(".main-view");
    expect(behind).not.toBeNull();
    expect(behind).toHaveAttribute("hidden");
    expect(behind?.childElementCount).toBeGreaterThan(0);
  });

  it("switches the workspace layout and remembers it", async () => {
    const user = userEvent.setup();
    go("#/settings/appearance");
    render(<App />);
    const layout = await screen.findByRole("radiogroup", { name: "Layout" });
    expect(within(layout).getByRole("radio", { name: /Console/ })).toBeChecked();
    await user.click(within(layout).getByRole("radio", { name: /Reading/ }));
    expect(document.documentElement.dataset.workspace).toBe("reading");
    expect(localStorage.getItem("orbyn.prefs.v1")).toContain('"workspaceLayout":"reading"');
    expect(localStorage.getItem("orbyn.prefs.v1")).toContain('"sidebarCollapsed":true');
  });
});
