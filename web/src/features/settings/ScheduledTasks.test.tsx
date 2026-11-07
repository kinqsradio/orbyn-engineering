import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as fixtures from "../../../mock/fixtures";
import { api } from "../../api/client";
import { useWorkspace } from "../../state/workspace";
import { installMockFetch } from "../../test-support";
import { ScheduledTasksSection } from "./ScheduledTasks";

afterEach(() => { vi.restoreAllMocks(); });

function ready() {
  useWorkspace.setState({
    projects: { data: fixtures.projects, error: null, loading: false },
    engines: { data: fixtures.engines, error: null, loading: false },
  });
}

it("opens the linked task's page on its Runs tab, and the editor only from Edit", async () => {
  ready();
  window.location.hash = "#/settings/tasks?task=task-review";
  installMockFetch();
  const user = userEvent.setup();
  render(<ScheduledTasksSection />);

  expect(await screen.findByRole("heading", { name: "Daily review" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Runs", selected: true })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Edit scheduled task" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect(await screen.findByRole("dialog", { name: "Edit scheduled task" })).toBeVisible();
});

it("opens the editor straight away from an Edit link", async () => {
  ready();
  window.location.hash = "#/settings/tasks?task=task-review&edit=1";
  installMockFetch();
  render(<ScheduledTasksSection />);
  expect(await screen.findByRole("dialog", { name: "Edit scheduled task" })).toBeVisible();
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
  await user.click(await screen.findByRole("button", { name: "Edit" }));
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

async function openIncomingHook() {
  ready();
  window.location.hash = "#/settings/tasks";
  installMockFetch();
  const user = userEvent.setup();
  render(<ScheduledTasksSection />);
  await user.click(await screen.findByText("Incoming hook"));
  expect(await screen.findByRole("heading", { name: "Incoming hook" })).toBeVisible();
  return user;
}

it("opens the task page from a row click, with Edit and Run now in its header and Runs first among its tabs", async () => {
  const user = await openIncomingHook();
  expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  expect(screen.getByRole("button", { name: "Run now" })).toBeVisible();
  expect(screen.getByText("Handle the webhook.")).toBeVisible();
  expect(screen.getByText("Webhook", { selector: "p" })).toBeVisible();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Runs", "Webhook deliveries"]);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect(await screen.findByRole("dialog", { name: "Edit scheduled task" })).toBeVisible();
});

it("names each of the eight outcomes and gives a refused or skipped run its reason", async () => {
  await openIncomingHook();
  const runs = await screen.findByRole("table", { name: "Runs" });
  const results = within(runs).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[2]?.textContent);
  expect(results).toEqual(["Queued", "Running", "Completed", "Failed", "Cancelled", "Interrupted", "Refused · webhook answer 401", "Skipped · limit window 92% used"]);
  expect(screen.getByText("Last 50 runs")).toBeVisible();
});

it("shows who sent each delivery as the sender's own claim, cut at 80 characters, and nothing when it names none", async () => {
  const user = await openIncomingHook();
  await user.click(screen.getByRole("tab", { name: "Webhook deliveries" }));
  const table = await screen.findByRole("table", { name: "Deliveries" });
  expect(within(table).getByRole("columnheader", { name: "Sent by" })).toBeVisible();
  expect(within(table).getByText("From GitHub")).toHaveAttribute("title", "As reported by the sender");
  const long = within(table).getByText(/^From Mozilla/);
  expect(long.textContent).toBe(`From ${"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36".slice(0, 80)}…`);
  const rows = within(table).getAllByRole("row");
  expect(within(rows[4] as HTMLElement).getAllByRole("cell")[1]).toBeEmptyDOMElement();
  expect(screen.queryByText("From", { exact: true })).toBeNull();
});

it("answers a delivery as 202 Accepted or 200 with one of six outcomes, each explained, and only Failed in the failed style", async () => {
  const delivery = (id: string, status: string) => ({ id, task_id: "task-hook", status, received_at: "2026-10-30T10:00:00Z", headers: {}, body: "{}", prompt: null, thread_id: null });
  vi.spyOn(api, "taskDeliveries").mockResolvedValue(["accepted", "bad_signature", "filtered", "duplicate", "stale", "disabled", "failed"].map((status, at) => delivery(`d${at}`, status)));
  const user = await openIncomingHook();
  await user.click(screen.getByRole("tab", { name: "Webhook deliveries" }));
  const table = await screen.findByRole("table", { name: "Deliveries" });
  const answers = ["202 Accepted", "200 Bad signature", "200 Filtered out", "200 Duplicate", "200 Stale", "200 Disabled", "200 Failed"];
  expect(answers.map((text) => within(table).getByText(text).textContent)).toEqual(answers);
  expect(within(table).getByText("200 Bad signature")).toHaveAttribute("title", "The signature didn’t match. Nothing ran.");
  expect(within(table).getByText("200 Stale")).toHaveAttribute("title", "Too old to run. Nothing ran.");
  expect(within(table).getByText("200 Failed")).toHaveAttribute("title", "Accepted, but the run failed.");
  expect(within(table).getByText("200 Failed")).toHaveClass("bad");
  expect(within(table).getByText("200 Bad signature")).not.toHaveClass("bad");
});

it("with no address yet, the deliveries tab says there are none and how to get some", async () => {
  vi.spyOn(api, "taskWebhook").mockResolvedValue({ configured: false, path_prefix: "/hooks/task-hook/" });
  vi.spyOn(api, "taskDeliveries").mockResolvedValue([]);
  const user = await openIncomingHook();
  await user.click(screen.getByRole("tab", { name: "Webhook deliveries" }));
  expect(await screen.findByText("No deliveries yet.")).toBeVisible();
  expect(await screen.findByText("Create an address to receive them.")).toBeVisible();
});

it("Run now reloads the Runs tab as well as the task list", async () => {
  const runs = vi.spyOn(api, "taskRuns").mockResolvedValue([]);
  vi.spyOn(api, "runTask").mockResolvedValue(undefined as never);
  const user = await openIncomingHook();
  await waitFor(() => expect(runs).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(runs).toHaveBeenCalledTimes(2));
});

it("shows the stored webhook address as configured, and the full address with Copy only right after it is regenerated", async () => {
  const user = await openIncomingHook();
  expect(await screen.findByText("Configured · /hooks/task-hook/…")).toBeVisible();
  expect(screen.getByText("Anyone with this address can start the task. Keep it private.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Regenerate address" }));
  expect(await screen.findByRole("button", { name: "Copy" })).toBeVisible();
  expect(screen.getByText("Copy it now. It isn’t shown again.")).toBeVisible();
  expect(screen.getByText(/\/hooks\/task-hook\/tok\d+x9f$/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Regenerate address" })).toBeNull();
});

it("offers Create address while a webhook task has none, and Regenerate address once it does", async () => {
  vi.spyOn(api, "taskWebhook").mockResolvedValue({ configured: false, path_prefix: "/hooks/task-hook/" });
  const user = await openIncomingHook();
  expect(await screen.findByText("No webhook address yet.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Regenerate address" })).toBeNull();
  vi.mocked(api.taskWebhook).mockResolvedValue({ configured: true, path_prefix: "/hooks/task-hook/" });
  await user.click(screen.getByRole("button", { name: "Create address" }));
  expect(await screen.findByRole("button", { name: "Copy" })).toBeVisible();
  expect(screen.getByText("Copy it now. It isn’t shown again.")).toBeVisible();
});

it("says so when a task has no runs yet", async () => {
  vi.spyOn(api, "taskRuns").mockResolvedValue([]);
  await openIncomingHook();
  expect(await screen.findByText("No runs yet.")).toBeVisible();
  expect(screen.getByText("Runs appear here after the task first runs.")).toBeVisible();
});

it("shows the two task defaults on the settings page, with Run while closed gone", async () => {
  ready();
  window.location.hash = "#/settings/tasks";
  installMockFetch();
  render(<ScheduledTasksSection />);
  expect(await screen.findByRole("switch", { name: "Skip a run when a limit is near" })).toBeVisible();
  expect(screen.getByText("Waits until a limit window has room (90% used or more). Applies to scheduled and follow-up runs.")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Notify when a run finishes or fails" })).toBeChecked();
  expect(screen.queryByText(/while closed/i)).toBeNull();
});
