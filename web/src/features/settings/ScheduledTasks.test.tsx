import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import * as fixtures from "../../../mock/fixtures";
import { useWorkspace } from "../../state/workspace";
import { installMockFetch } from "../../test-support";
import { ScheduledTasksSection } from "./ScheduledTasks";

function ready() {
  useWorkspace.setState({
    projects: { data: fixtures.projects, error: null, loading: false },
    engines: { data: fixtures.engines, error: null, loading: false },
  });
}

it("opens the linked task and clears the link when the editor closes", async () => {
  ready();
  window.location.hash = "#/settings/tasks?task=task-review";
  installMockFetch();
  const user = userEvent.setup();
  render(<ScheduledTasksSection />);

  expect(await screen.findByRole("dialog", { name: "Edit scheduled task" })).toBeVisible();
  expect(screen.getByDisplayValue("Daily review")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(window.location.hash).toBe("#/settings/tasks"));
  expect(screen.queryByRole("dialog", { name: "Edit scheduled task" })).toBeNull();
});

it("drops a link to a task that no longer exists without opening an editor", async () => {
  ready();
  window.location.hash = "#/settings/tasks?task=gone";
  installMockFetch();
  render(<ScheduledTasksSection />);

  await waitFor(() => expect(window.location.hash).toBe("#/settings/tasks"));
  expect(screen.queryByRole("dialog", { name: "Edit scheduled task" })).toBeNull();
});

it("deletes a task only after the second question inside Edit", async () => {
  ready();
  window.location.hash = "#/settings/tasks";
  installMockFetch();
  const calls = { some: (test: (call: { method: string; path: string }) => boolean) => vi.mocked(fetch).mock.calls.map(([url, init]) => ({ method: (init as RequestInit | undefined)?.method ?? "GET", path: String(url) })).some(test) };
  const user = userEvent.setup();
  render(<ScheduledTasksSection />);
  await user.click(await screen.findByRole("button", { name: "Edit Daily review" }));
  await user.click(await screen.findByRole("button", { name: "Delete task…" }));
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  const ask = await screen.findByRole("dialog", { name: "Delete Daily review?" });
  await user.click(within(ask).getByRole("button", { name: "Delete task" }));
  await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path.includes("task-review"))).toBe(true));
});

it("opens a task from its row and starts a run from there", async () => {
  ready();
  window.location.hash = "#/settings/tasks";
  installMockFetch();
  const calls = { some: (test: (call: { method: string; path: string }) => boolean) => vi.mocked(fetch).mock.calls.map(([url, init]) => ({ method: (init as RequestInit | undefined)?.method ?? "GET", path: String(url) })).some(test) };
  const user = userEvent.setup();
  render(<ScheduledTasksSection />);
  await user.click(await screen.findByRole("button", { name: "Open Daily review" }));
  expect(await screen.findByRole("heading", { name: "Daily review" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/task-review/run"))).toBe(true));
});

it("puts Name first, typed by the person, and refuses to save without one", async () => {
  ready();
  window.location.hash = "#/settings/tasks?task=task-review";
  installMockFetch();
  const user = userEvent.setup();
  render(<ScheduledTasksSection />);
  const dialog = await screen.findByRole("dialog", { name: "Edit scheduled task" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  expect(dialog.querySelector("input, textarea, select")).toBe(name);
  expect(within(dialog).queryByText("Give the task a name.")).toBeNull();
  await user.clear(name);
  expect(within(dialog).getByText("Give the task a name.")).toBeVisible();
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.type(name, "Morning review");
  expect(within(dialog).queryByText("Give the task a name.")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeEnabled();
});
