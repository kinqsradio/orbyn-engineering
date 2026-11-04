import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { installMockFetch } from "../../test-support";
import { ThreadAutomations } from "./ThreadAutomations";

it("lists only the tasks bound to the thread", async () => {
  installMockFetch();
  render(<ThreadAutomations threadId="t-approval" />);
  expect(await screen.findByText("Daily review")).toBeVisible();
  expect(screen.getByText("Incoming hook")).toBeVisible();
  expect(screen.queryByText("Explain the event log")).toBeNull();
});

it("renders nothing for a thread with no automations", async () => {
  installMockFetch();
  const { container } = render(<ThreadAutomations threadId="t-empty" />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it("offers Run now for scheduled work but not for a webhook", async () => {
  installMockFetch();
  render(<ThreadAutomations threadId="t-approval" />);
  expect(await screen.findByRole("button", { name: "Run Daily review now" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Run Incoming hook now" })).toBeNull();
});

it("pauses a task through the enabled route and reflects the new state", async () => {
  const user = userEvent.setup();
  installMockFetch();
  render(<ThreadAutomations threadId="t-approval" />);
  await user.click(await screen.findByRole("switch", { name: "Pause Daily review" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/tasks/task-review/enabled"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ enabled: false }) }),
    ),
  );
  expect(await screen.findByRole("switch", { name: "Resume Daily review" })).not.toBeChecked();
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
