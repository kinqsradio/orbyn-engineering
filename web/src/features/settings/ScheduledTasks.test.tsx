import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import * as fixtures from "../../../mock/fixtures";
import { useWorkspace } from "../../state/workspace";
import { installMockFetch } from "../../test-support";
import { ScheduledTasksPage, ScheduledTasksSection } from "./ScheduledTasks";

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

it.each([
  ["page", ScheduledTasksPage],
  ["settings", ScheduledTasksSection],
] as const)("confirms the selected task before deleting on the %s surface", async (_, Surface) => {
  ready();
  window.location.hash = "#/settings/tasks";
  const mock = installMockFetch();
  const fetchSpy = vi.mocked(globalThis.fetch);
  const user = userEvent.setup();
  render(<Surface />);

  await user.click(await screen.findByRole("button", { name: "Delete Incoming hook" }));
  let dialog = screen.getByRole("dialog", { name: "Delete scheduled task?" });
  expect(within(dialog).getByText("Delete Incoming hook?")).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  expect(within(dialog).getByRole("button", { name: "Delete task" })).toHaveClass("btn-danger");
  expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  expect(mock.handle("GET", "/api/tasks").body).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "task-hook" }),
    expect.objectContaining({ id: "task-review" }),
  ]));

  await user.click(screen.getByRole("button", { name: "Delete Incoming hook" }));
  dialog = screen.getByRole("dialog", { name: "Delete scheduled task?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete task" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(screen.queryByRole("button", { name: "Delete Incoming hook" })).toBeNull());
  expect(screen.getByRole("button", { name: "Delete Daily review" })).toBeVisible();
  expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url)).toEqual(["/api/tasks/task-hook"]);
  expect(mock.handle("GET", "/api/tasks").body).toEqual(expect.not.arrayContaining([
    expect.objectContaining({ id: "task-hook" }),
  ]));
  expect(mock.handle("GET", "/api/tasks").body).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "task-review" }),
  ]));
});

it("keeps a failed deletion open for retry", async () => {
  ready();
  window.location.hash = "#/settings/tasks";
  const mock = installMockFetch();
  const inner = globalThis.fetch;
  let fail = true;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (fail && init?.method === "DELETE") {
      fail = false;
      return new Response(JSON.stringify({ code: "unavailable", message: "Delete unavailable." }), { status: 503 });
    }
    return inner(input, init);
  }));
  const user = userEvent.setup();
  render(<ScheduledTasksPage />);
  await user.click(await screen.findByRole("button", { name: "Delete Daily review" }));
  const dialog = screen.getByRole("dialog", { name: "Delete scheduled task?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete task" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Delete unavailable.");
  expect(mock.handle("GET", "/api/tasks").body).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "task-review" }),
  ]));
  await user.click(within(dialog).getByRole("button", { name: "Delete task" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mock.handle("GET", "/api/tasks").body).toEqual(expect.not.arrayContaining([
    expect.objectContaining({ id: "task-review" }),
  ]));
});
