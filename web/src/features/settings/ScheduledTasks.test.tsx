import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
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
