import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { PreferenceView } from "../../api/types";
import type { ScopedPreferencesChange } from "../../generated/ScopedPreferencesChange";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import { ProjectModelDefaults } from "./ProjectModelDefaults";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
vi.mock("../../state/workspace", () => ({ useWorkspace: (select: (state: unknown) => unknown) =>
  select({ engines: { data: [{ id: "codex", name: "Codex", installed: true }] } }) }));
vi.mock("../thread/ModelPicker", () => ({ ModelPickerTrigger: ({ selected, onPick, disabled }: {
  selected: { engine: string; model: string | null }; onPick(choice: { engine: string; model: string }): void; disabled: boolean;
}) => <button disabled={disabled} onClick={() => onPick({ engine: "codex", model: "chosen" })}>
  Choose model ({selected.engine}/{selected.model ?? "automatic"})</button> }));
const mocked = vi.mocked(request);
const checkout: ProjectScopesQuery = { selection: { kind: "checkout", group_key: "group-a", project_id: "a" } };
const views = (engine = "codex", model = "old", source = "project"): PreferenceView[] =>
  [{ key: "default_engine", value: engine, default: "", source, project_scoped: true },
    { key: "default_model", value: model, default: "", source, project_scoped: true }];
let data: ScopedPreferencesResult, writes: ScopedPreferencesChange[], failure: boolean;
beforeEach(() => {
  data = scopedFixture(views(), views("", "", "default"), "a"); writes = []; failure = false;
  mocked.mockReset(); mocked.mockImplementation(async (method, _path, body) => {
    if (method === "POST") return data as never;
    const change = body as ScopedPreferencesChange;
    writes.push(change);
    if (failure) throw new ApiFailure("settings_conflict", "Settings changed", 409);
    return data as never;
  });
});

it("commits one version-fenced provider/model tuple and leaves opening the control read-only", async () => {
  const user = userEvent.setup(); render(<ProjectModelDefaults query={checkout} />);
  const choose = await screen.findByRole("button", { name: /Choose model/ });
  expect(writes).toHaveLength(0);
  await user.click(choose);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ scope: checkout, membership_version: "catalog",
    if_match: Object.fromEntries(data.rows.map((row) => [row.key, row.revision])),
    edits: { default_engine: { op: "set", value: "codex" }, default_model: { op: "set", value: "chosen" } } });
});

it("retains a conflicting model draft and requires explicit reload before retry with fresh revisions", async () => {
  const user = userEvent.setup(); failure = true;
  render(<ProjectModelDefaults query={checkout} />);
  await user.click(await screen.findByRole("button", { name: /Choose model/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings changed");
  expect(screen.getByRole("button", { name: /Choose model \(codex\/chosen\)/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  data = { ...data, rows: data.rows.map((row) => ({ ...row, revision: `new-${row.key}` })) };
  failure = false;
  await user.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled());
  expect(writes).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]?.if_match).toEqual({ default_engine: "new-default_engine", default_model: "new-default_model" });
  expect(writes[1]?.edits.default_model).toEqual({ op: "set", value: "chosen" });
});

it("inherits both keys together while Automatic sets both keys explicitly", async () => {
  const user = userEvent.setup(); render(<ProjectModelDefaults query={checkout} />);
  await user.click(await screen.findByRole("button", { name: "Inherit" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.edits).toEqual({ default_engine: { op: "inherit" }, default_model: { op: "inherit" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Automatic" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Automatic" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]?.edits).toEqual({ default_engine: { op: "set", value: "" }, default_model: { op: "set", value: "" } });
});

it("does not write Mixed values on read and resets only captured tuple overrides", async () => {
  data = scopedFixture(views("codex", "old", "global"));
  data.rows = data.rows.map((row) => ({ ...row, mixed: true,
    overrides: [{ project_id: row.key === "default_engine" ? "a" : "b", name: "Overridden", value: "old" }] }));
  const user = userEvent.setup(); render(<ProjectModelDefaults query={{}} />);
  expect(await screen.findByText("Mixed")).toBeVisible(); expect(writes).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Reset all" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.edits).toEqual({ default_engine: { op: "reset_overrides", project_ids: ["a", "b"] },
    default_model: { op: "reset_overrides", project_ids: ["a", "b"] } });
});

it("never applies a late old-scope save to a different mounted selection", async () => {
  let done!: (value: ScopedPreferencesResult) => void;
  mocked.mockImplementation(async (method) => method === "POST" ? data as never
    : new Promise((resolve) => { done = resolve as never; }) as never);
  const user = userEvent.setup(); const { rerender } = render(<ProjectModelDefaults query={checkout} />);
  await user.click(await screen.findByRole("button", { name: /Choose model/ }));
  data = scopedFixture(views("codex", "b-model"), undefined, "b");
  rerender(<ProjectModelDefaults query={{ selection: { kind: "checkout", group_key: "group-b", project_id: "b" } }} />);
  expect(await screen.findByRole("button", { name: /b-model/ })).toBeEnabled();
  await act(async () => done(scopedFixture(views("codex", "old-reply"), undefined, "a")));
  expect(screen.getByRole("button", { name: /b-model/ })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /old-reply/ })).not.toBeInTheDocument();
});
