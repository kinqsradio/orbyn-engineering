import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { MockApi } from "../../mock/api";
import { installMockFetch } from "../test-support";
import { App } from "./App";

let mock: MockApi;

beforeEach(() => {
  mock = installMockFetch();
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
    await user.click(await screen.findByRole("button", { name: /^Engine:/ }));
    expect(await screen.findByRole("menuitem", { name: /Aider \(terminal\) \(Unmanaged\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Cursor Agent/ })).toBeNull();
  });

  it("labels an unmanaged engine in the sidebar", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    expect(await within(nav).findByText("Unmanaged")).toBeInTheDocument();
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
    await user.click(within(nav).getByRole("button", { name: "Search" }));
    await user.type(within(nav).getByRole("searchbox", { name: "Search threads" }), "tokio");
    expect(within(nav).queryByText("Explain how the event log resumes")).toBeNull();
    expect(within(nav).getByText("Upgrade tokio and fix the fallout")).toBeInTheDocument();
  });

  describe("updates", () => {
    const idle = () => {
      for (const thread of mock.threads) thread.active_run = null;
    };
    const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole("button", { name: "3 updates available" }));
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

    it("lists versions, commits and notes, and disables with the reason", async () => {
      const user = userEvent.setup();
      render(<App />);
      const dialog = await openDialog(user);
      expect(within(dialog).getByText("Claude Code")).toBeInTheDocument();
      expect(within(dialog).getByText("2.1.14 → 2.1.20")).toBeInTheDocument();
      expect(within(dialog).getByText("Add statechart review guidance")).toBeInTheDocument();
      expect(within(dialog).getByText("Faster thread loading")).toBeInTheDocument();
      expect(within(dialog).getByText(/runs are active/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Update all" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Update app" })).toBeDisabled();
    });

    it("runs in order, stops at the first failure and retries", async () => {
      idle();
      mock.failUpdateStep("library");
      const user = userEvent.setup();
      render(<App />);
      const dialog = await openDialog(user);
      await user.click(within(dialog).getByRole("button", { name: "Update all" }));
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
      await user.click(await screen.findByRole("button", { name: "2 updates available" }));
      const dialog = await screen.findByRole("dialog", { name: "Update everything" });
      expect(within(dialog).getByText(/Replace the orbynd binary/)).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Update app" })).toBeNull();
    });

    it("checks from Settings without applying anything", async () => {
      const user = userEvent.setup();
      go("#/settings/maintenance");
      render(<App />);
      const before = mock.updates.checked_at;
      await user.click(await screen.findByRole("button", { name: "Check for updates" }));
      await waitFor(() => expect(mock.updates.checked_at).not.toBe(before));
      expect(mock.updates.engines[0]?.current).toBe("2.1.14");
      const background = screen.getByRole("checkbox", { name: "Check in the background" });
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
    await user.click(screen.getByRole("tab", { name: "Import local folder" }));
    await user.click(await screen.findByRole("button", { name: "code" }));
    await user.click(await screen.findByRole("button", { name: /payments-service/ }));
    await waitFor(() => expect(screen.getByTitle("/Users/dev/code/payments-service")).toBeInTheDocument());
    expect(screen.getByText(/original folder stays untouched/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import this folder" }));

    const report = await screen.findByRole("region", { name: "Import result" });
    expect(within(report).getByText("src/draft.rs")).toBeInTheDocument();
    expect(within(report).getByText("spike/retry-queue")).toBeInTheDocument();
    await user.click(within(report).getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Trust this folder?" })).toBeInTheDocument();
    expect(screen.getByText(/execute this repository's hooks/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trust folder" }));

    expect(await screen.findByRole("heading", { name: /What should we build in/ })).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox", { name: "Message" }), "go{Enter}");
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/threads\//));
  });

  it("clones from a URL and keeps it on failure", async () => {
    mock.fail("/api/projects/clone", 1, 502, "clone_failed", "The remote refused.");
    const user = userEvent.setup();
    go("#/add-project");
    render(<App />);
    await user.type(await screen.findByLabelText("Repository URL"), "https://example.com/team/repo.git");
    await user.click(screen.getByRole("button", { name: "Clone project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The remote refused.");
    expect(screen.getByLabelText("Repository URL")).toHaveValue("https://example.com/team/repo.git");
    await user.click(screen.getByRole("button", { name: "Retry clone" }));
    expect(await screen.findByRole("heading", { name: "Trust this folder?" })).toBeInTheDocument();
  });

  it("creates a new project", async () => {
    const user = userEvent.setup();
    go("#/add-project");
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Create new" }));
    await user.type(screen.getByLabelText("Project name"), "fresh-idea");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("heading", { name: /What should we build in/ })).toBeInTheDocument();
  });

  it("blocks everything on first run until setup finishes", async () => {
    mock.reset("first-run");
    mock.failSetup();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Set up your workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Set up workspace" }));
    expect(await screen.findByText("Setup didn't finish")).toBeInTheDocument();
    expect(screen.getByText(/couldn't be reached/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Add your first project" }, { timeout: 3000 })).toBeInTheDocument();
  });

  it("adopts an existing library folder", async () => {
    mock.reset("first-run");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("radio", { name: /Adopt an existing library/ }));
    await user.click(await screen.findByRole("button", { name: "Adopt this folder" }));
    expect(await screen.findByRole("heading", { name: "Add your first project" }, { timeout: 3000 })).toBeInTheDocument();
  });

  it("reviews incoming commits before updating the library", async () => {
    for (const thread of mock.threads) thread.active_run = null;
    const user = userEvent.setup();
    go("#/settings/projects");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Review update" }));
    const dialog = await screen.findByRole("dialog", { name: "Update the library?" });
    expect(within(dialog).getByText("Add statechart review guidance")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    expect(await screen.findByText("The library is up to date.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review update" })).toBeDisabled();
  });

  it("disables library updates while runs are active", async () => {
    go("#/settings/projects");
    render(<App />);
    expect(await screen.findByText(/runs are active/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review update" })).toBeDisabled();
  });

  it("disables library changes with the reason", async () => {
    mock.patchWorkspace({
      library: { ...mock.workspace.library!, dirty: true, dirty_files: ["skills/a.md"] },
    });
    go("#/settings/projects");
    render(<App />);
    expect(await screen.findByText(/local changes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review update" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
  });

  it("blocks removing a project with unpushed work until acknowledged", async () => {
    const user = userEvent.setup();
    go("#/settings/projects");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Remove marketing-site" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove marketing-site?" });
    expect(within(dialog).getByText(/uncommitted changes/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Remove project" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(confirm);
    expect(await screen.findByText(/stays at \/Users\/dev\/code\/marketing-site/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "marketing-site" })).toBeNull());
  });

  it("shows the selected branch in the thread", async () => {
    go("#/threads/t-approval");
    render(<App />);
    const composer = (await screen.findByLabelText(/^Message/)).closest("form");
    expect(within(composer as HTMLElement).getByText("approval-timeout")).toBeInTheDocument();
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
    expect(await screen.findByText("Grep")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Plan" })).toBeInTheDocument();
    expect(await screen.findByRole("article", { name: "Run the core test suite" })).toBeInTheDocument();
    expect(document.querySelector(".thread-state")).toHaveTextContent("Approval");
  });

  it("streams a run to completion", async () => {
    const user = userEvent.setup();
    go("#/threads/t-empty");
    render(<App />);
    await user.type(await screen.findByLabelText(/^Message/), "go{Enter}");
    expect(await screen.findByText("scripted reply", {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(
      () => expect(document.querySelector(".thread-state")).toHaveTextContent("Completed"),
      { timeout: 3000 },
    );
    expect(screen.getByText("go")).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Trust this folder?" })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Claude Code" })).toBeInTheDocument();
  });

  it("confirms an engine update and refuses during an active run", async () => {
    const user = userEvent.setup();
    go("#/settings/providers");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Update to 2.1.20" }));
    const dialog = await screen.findByRole("dialog", { name: "Update Claude Code?" });
    expect(within(dialog).getByText("npm install -g @anthropic-ai/claude-code")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("active run");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("never asks for an engine credential", async () => {
    go("#/settings/providers");
    render(<App />);
    await screen.findByRole("heading", { name: "Codex" });
    expect(screen.getByText(/Sign in through the Codex CLI/)).toBeInTheDocument();
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

  it("offers only surfaces it can back", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    go("#/threads/t-done");
    render(<App />);
    const launcher = await screen.findByLabelText("Open a surface");
    expect(within(launcher).getByRole("button", { name: /Terminal/ })).toBeEnabled();
    expect(within(launcher).getByRole("button", { name: /Diff/ })).toBeDisabled();
    expect(within(launcher).queryByRole("button", { name: /Browser/ })).toBeNull();
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
    const slider = await screen.findByRole("slider", { name: /Panel animations/ });
    expect(slider).toHaveValue("0");
    fireEvent.change(slider, { target: { value: "240" } });
    expect(localStorage.getItem("orbyn.prefs.v1")).toContain('"panelAnimationMs":240');
  });

  it("switches and remembers the theme", async () => {
    const user = userEvent.setup();
    go("#/settings/appearance");
    render(<App />);
    const theme = await screen.findByRole("combobox", { name: "Theme" });
    expect(theme).toHaveValue("dark");
    await user.selectOptions(theme, "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("orbyn.prefs.v1")).toContain('"theme":"light"');
  });
});
