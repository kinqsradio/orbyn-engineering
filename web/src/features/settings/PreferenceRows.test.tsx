import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { PreferenceView } from "../../api/types";
import { PreferenceGroups } from "./PreferenceRows";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
const groups = [{ title: "Source control", rows: [{ key: "auto_pull", title: "Auto pull", inheritance: true }] }];
const requestMock = vi.mocked(request);
let globalValue: boolean | undefined;
let overrides: Record<string, boolean>;
let failRead: boolean;
let failWrite: boolean;
let holdWrite: Promise<void> | undefined;
let writes: { project: string; values: Record<string, unknown> }[];
function views(project?: string): PreferenceView[] {
  const own = project === undefined ? undefined : overrides[project];
  return [{ key: "auto_pull", value: own ?? globalValue ?? false, default: false,
    source: own !== undefined ? "project" : globalValue !== undefined ? "global" : "default", project_scoped: true }];
}
beforeEach(() => {
  globalValue = true; overrides = { a: false, b: true }; failRead = false; failWrite = false; holdWrite = undefined; writes = [];
  requestMock.mockReset();
  requestMock.mockImplementation(async (method, path, body) => {
    const url = new URL(path, "http://local");
    if (method === "GET") {
      if (failRead && !url.searchParams.has("project_id")) throw new ApiFailure("unavailable", "Read failed.", 503);
      return views(url.searchParams.get("project_id") ?? undefined) as never;
    }
    const project = decodeURIComponent(/^\/api\/projects\/([^/]+)\/preferences$/.exec(path)?.[1] ?? "");
    const values = (body as { values: Record<string, unknown> }).values;
    writes.push({ project, values });
    if (holdWrite) await holdWrite;
    if (failWrite) throw new ApiFailure("unavailable", "Save failed.", 503);
    if (values.auto_pull === null) delete overrides[project];
    else overrides[project] = values.auto_pull === true;
    return views(project) as never;
  });
});

describe("project preference inheritance", () => {
  it("removes only the selected override and follows later global changes", async () => {
    const user = userEvent.setup();
    const first = render(<PreferenceGroups groups={groups} projectId="a" />);
    expect(await screen.findByRole("switch", { name: "Auto pull" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Reset Auto pull to default" }));
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    expect(writes).toEqual([{ project: "a", values: { auto_pull: null } }]);
    expect(overrides).toEqual({ b: true }); expect(globalValue).toBe(true);
    first.unmount(); globalValue = false;
    render(<PreferenceGroups groups={groups} projectId="a" />);
    expect(await screen.findByRole("switch")).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Reset Auto pull to default" })).toBeNull();
  });

  it("keeps an equal-valued explicit override resettable and explains all three layers", async () => {
    const user = userEvent.setup();
    render(<PreferenceGroups groups={groups} projectId="b" />);
    await screen.findByRole("switch");
    expect(screen.getByRole("button", { name: "Reset Auto pull to default" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reset Auto pull to default" })).toHaveAttribute("title", "Reset to inherited value");
    const source = screen.getByRole("button", { name: /Overridden for this project.*Show where this value comes from/ });
    source.focus(); await user.keyboard("{Enter}");
    const popup = await screen.findByRole("dialog", { name: "Auto pull" });
    expect(within(popup).getByText("Project").closest("li")).toHaveTextContent("On");
    expect(within(popup).getByText("Environment").closest("li")).toHaveTextContent("On");
    expect(within(popup).getByText("Default").closest("li")).toHaveTextContent("Off");
    expect(within(popup).queryByText("t3.json")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Auto pull" })).toBeNull(); expect(source).toHaveFocus();
    expect(writes).toHaveLength(0);
  });

  it("retains an override after a failed reset", async () => {
    const user = userEvent.setup(); failWrite = true;
    render(<PreferenceGroups groups={groups} projectId="a" />);
    await screen.findByRole("switch");
    await user.click(screen.getByRole("button", { name: "Reset Auto pull to default" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed.");
    expect(screen.getByRole("switch")).not.toBeChecked(); expect(overrides.a).toBe(false);
    expect(screen.getByRole("button", { name: "Reset Auto pull to default" })).toBeEnabled();
  });

  it("does not fabricate inherited values when the global layer cannot be read", async () => {
    failRead = true;
    render(<PreferenceGroups groups={groups} projectId="a" />);
    expect(await screen.findByText("Couldn't load settings")).toBeVisible();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /Show where this value comes from/ })).toBeNull();
    failRead = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("switch")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Reset Auto pull to default" })).toBeEnabled();
  });

  it("does not show an earlier project's pending save under the replacement project", async () => {
    const user = userEvent.setup(); let release = () => {};
    holdWrite = new Promise<void>((resolve) => { release = resolve; }); overrides.b = false;
    const view = render(<PreferenceGroups groups={groups} projectId="a" />);
    await user.click(await screen.findByRole("switch"));
    await waitFor(() => expect(writes).toHaveLength(1));
    view.rerender(<PreferenceGroups groups={groups} projectId="b" />);
    expect(await screen.findByRole("switch")).not.toBeChecked();
    await act(async () => { release(); await holdWrite; });
    await waitFor(() => expect(overrides.a).toBe(true));
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(writes[0]?.project).toBe("a"); expect(overrides.b).toBe(false);
  });
});
