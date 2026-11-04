import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { installMockFetch } from "../../test-support";
import { ThreadAutomations } from "./ThreadAutomations";

it("lists only the tasks bound to the thread", async () => {
  installMockFetch();
  render(<ThreadAutomations threadId="t-approval" />);
  expect(await screen.findByText("Daily review")).toBeVisible();
  expect(screen.getByText("Incoming hook")).toBeVisible();
  expect(screen.queryByText("Explain the event log")).toBeNull();
});

it("renders nothing for a thread with no automations once the list resolves", async () => {
  installMockFetch();
  const inner = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Promise<Response>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const call = gate.then(() => inner(input, init));
      calls.push(call);
      return call;
    }),
  );
  const { container } = render(<ThreadAutomations threadId="t-empty" />);
  expect(container).toBeEmptyDOMElement();
  await act(async () => {
    release();
    await Promise.all(calls);
  });
  expect(container).toBeEmptyDOMElement();
});

it("offers Run now for scheduled work but not for a webhook", async () => {
  installMockFetch();
  render(<ThreadAutomations threadId="t-approval" />);
  expect(await screen.findByRole("button", { name: "Run Daily review now" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Run Incoming hook now" })).toBeNull();
});

it("keeps the pause state until the reloaded row carries it", async () => {
  const user = userEvent.setup();
  installMockFetch();
  const inner = globalThis.fetch;
  let gets = 0;
  let release!: () => void;
  const reloadGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && input === "/api/tasks" && ++gets > 1) await reloadGate;
      return inner(input, init);
    }),
  );
  render(<ThreadAutomations threadId="t-approval" />);
  const control = await screen.findByRole("switch", { name: "Enable Daily review" });
  expect(control).toBeChecked();
  await user.click(control);
  await waitFor(() => expect(gets).toBe(2));
  expect(control).not.toBeChecked();
  release();
  await waitFor(() => expect(control).toBeEnabled());
  expect(control).not.toBeChecked();
});

it("runs a task now", async () => {
  const user = userEvent.setup();
  installMockFetch();
  render(<ThreadAutomations threadId="t-approval" />);
  await user.click(await screen.findByRole("button", { name: "Run Daily review now" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/tasks/task-review/run"),
      expect.objectContaining({ method: "POST" }),
    ),
  );
});

it("refreshes the row after a failed run", async () => {
  const user = userEvent.setup();
  const mock = installMockFetch();
  const inner = globalThis.fetch;
  let gets = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && input === "/api/tasks") gets += 1;
      return inner(input, init);
    }),
  );
  mock.fail("/api/tasks/task-review/run", 1, 500, "internal", "The engine did not start.");
  render(<ThreadAutomations threadId="t-approval" />);
  await user.click(await screen.findByRole("button", { name: "Run Daily review now" }));
  await waitFor(() => expect(gets).toBe(2));
});

it("names the status dot for readers who cannot see its colour", async () => {
  installMockFetch();
  render(<ThreadAutomations threadId="t-approval" />);
  expect(await screen.findByRole("img", { name: "Last run started" })).toBeVisible();
  expect(screen.getByRole("img", { name: "Not run yet" })).toBeVisible();
});

it("links Edit to the task and Manage to the section", async () => {
  const user = userEvent.setup();
  installMockFetch();
  render(<ThreadAutomations threadId="t-approval" />);
  await user.click(await screen.findByRole("button", { name: "Edit Daily review" }));
  expect(window.location.hash).toBe("#/settings/tasks?task=task-review");
  await user.click(screen.getByRole("button", { name: "Manage scheduled tasks" }));
  expect(window.location.hash).toBe("#/settings/tasks");
});

it("keeps the section and offers Retry when the list fails", async () => {
  const user = userEvent.setup();
  const mock = installMockFetch();
  mock.fail("/api/tasks", 1, 500, "internal", "The service is unavailable.");
  render(<ThreadAutomations threadId="t-approval" />);
  expect(await screen.findByText("Couldn't load automations")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Daily review")).toBeVisible();
});
