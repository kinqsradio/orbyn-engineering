import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as fixtures from "../../../mock/fixtures";
import { api } from "../../api/client";
import type { Thread } from "../../api/types";
import { useWorkspace } from "../../state/workspace";
import { ArchiveSection } from "./PreferenceSections";

afterEach(() => vi.restoreAllMocks());

const [base] = fixtures.threads() as [Thread];
const archived = (id: string, title: string, patch: Partial<Thread> = {}): Thread => ({ ...base, id, title, updated_at: "2026-10-20T09:00:00Z", ...patch });

it("lists a removed project's threads under its name with a Removed tag, and Unarchive waits for the project to come back", async () => {
  useWorkspace.setState({ projects: { data: fixtures.projects, error: null, loading: false } });
  vi.spyOn(api, "archivedThreads").mockResolvedValue([
    archived("kept", "Usage cost filters", { project_id: "p-app" }),
    archived("gone", "Compare the license lists", { project_id: "p-removed", project_removed: true, removed_project_name: "orbyn-references" }),
  ]);
  render(<ArchiveSection />);
  const removed = await screen.findByRole("region", { name: "orbyn-references" });
  expect(within(removed).getByText("Removed")).toBeVisible();
  expect(within(removed).getByText("Compare the license lists")).toBeVisible();
  expect(within(removed).getByRole("button", { name: "Unarchive" })).toBeDisabled();
  expect(within(removed).getByRole("button", { name: "Unarchive" }).parentElement).toHaveAttribute("title", "Add the project back to unarchive");
  expect(within(removed).getByRole("button", { name: "Delete" })).toBeEnabled();

  const live = screen.getByRole("region", { name: fixtures.projects[0]?.name ?? "" });
  expect(within(live).queryByText("Removed")).toBeNull();
  expect(within(live).getByRole("button", { name: "Unarchive" })).toBeEnabled();
});
