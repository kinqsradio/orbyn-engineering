import { render, screen, waitFor, within } from "@testing-library/react";
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
  it("opens on the workspace with the global approval count", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    expect(await within(nav).findByRole("link", { name: "Approvals, 3 pending approvals" })).toBeInTheDocument();
    expect(await within(nav).findByText("Upgrade tokio and fix the fallout")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("(3) Orbyn Engineering"));
  });

  it("labels an unmanaged engine in the sidebar", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    expect(await within(nav).findByText("Unmanaged")).toBeInTheDocument();
  });

  it("collapses many threads behind a count", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: "Show 20 more" })).toBeInTheDocument();
  });

  it("walks a new person from empty state to a thread", async () => {
    mock.reset("empty");
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Add your first project" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "code" }));
    await user.click(await screen.findByRole("button", { name: /payments-service/ }));
    await waitFor(() => expect(screen.getByTitle("/Users/dev/code/payments-service")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Use this folder" }));

    expect(await screen.findByRole("heading", { name: "Trust this folder?" })).toBeInTheDocument();
    expect(screen.getByText(/execute this repository's hooks/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trust folder" }));

    expect(await screen.findByRole("heading", { name: "New thread" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/threads\//));
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
    expect(await screen.findByRole("article", { name: "Approval: Run the core test suite" })).toBeInTheDocument();
    expect(document.querySelector(".thread-state")).toHaveTextContent("Waiting for you");
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
    await user.click(await screen.findByRole("button", { name: /^Cancel/ }));
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

  it("shows engine tiers, login and the unmanaged warning when picking an engine", async () => {
    go("#/new/p-app");
    render(<App />);
    expect(await screen.findByRole("radio", { name: /Claude Code/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Cursor Agent/ })).toBeDisabled();
    expect(screen.getByText(/Sign in through the Codex CLI/)).toBeInTheDocument();
    expect(screen.getByText(/Can't ask permission/)).toBeInTheDocument();
  });

  it("recovers an Engines failure with retry", async () => {
    mock.fail("/api/engines", 1);
    const user = userEvent.setup();
    go("#/settings/engines");
    render(<App />);
    expect(await screen.findByText("Couldn't load engines")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Claude Code" })).toBeInTheDocument();
  });

  it("confirms an engine update and refuses during an active run", async () => {
    const user = userEvent.setup();
    go("#/settings/engines");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Update to 2.1.20" }));
    const dialog = await screen.findByRole("dialog", { name: "Update Claude Code?" });
    expect(within(dialog).getByText("npm install -g @anthropic-ai/claude-code")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("active run");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("adds and deletes a policy rule", async () => {
    const user = userEvent.setup();
    go("#/settings/policy");
    render(<App />);
    await user.type(await screen.findByLabelText("Target pattern"), "git push*");
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    const remove = await screen.findByRole("button", { name: "Delete rule git push*" });
    await user.click(remove);
    await user.click(await screen.findByRole("button", { name: "Delete rule" }));
    await waitFor(() => expect(screen.queryByText("git push*")).toBeNull());
  });

  it("filters the audit log", async () => {
    const user = userEvent.setup();
    go("#/settings/audit");
    render(<App />);
    await screen.findAllByText("policy.evaluate");
    await user.type(screen.getByLabelText("Search"), "project.trust");
    await waitFor(() => expect(screen.queryByText("policy.evaluate")).toBeNull());
    await user.clear(screen.getByLabelText("Search"));
    await user.type(screen.getByLabelText("Search"), "nothing-matches");
    expect(await screen.findByText("No matching rows")).toBeInTheDocument();
  });

  it("never asks for an engine credential", async () => {
    go("#/settings/engines");
    render(<App />);
    await screen.findByRole("heading", { name: "Codex" });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/api key|paste your token/i);
  });

  it("switches and remembers the theme", async () => {
    const user = userEvent.setup();
    go("#/settings/appearance");
    render(<App />);
    await user.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("orbyn.prefs.v1")).toContain('"theme":"dark"');
  });
});
