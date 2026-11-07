import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { EngineModels, PreferenceView } from "../../api/types";
import type { ScopedPreferencesChange } from "../../generated/ScopedPreferencesChange";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import { ProjectModelDefaults } from "./ProjectModelDefaults";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";
import { useModelStore } from "../../state/modelStore";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
vi.mock("../../state/workspace", () => ({ useWorkspace: (select: (state: unknown) => unknown) =>
  select({ engines: { data: [{ id: "codex", name: "Codex", installed: true }] } }) }));
vi.mock("../thread/ModelPicker", () => ({ ModelPickerTrigger: ({ selected, onPick, disabled, triggerLabel }: {
  selected: { engine: string; model: string | null }; onPick(choice: { engine: string; model: string }): void; disabled: boolean; triggerLabel?: string;
}) => <button disabled={disabled} onClick={() => onPick({ engine: "codex", model: "chosen" })}>
  {triggerLabel ?? `Choose model (${selected.engine}/${selected.model ?? "automatic"})`}</button> }));
const mocked = vi.mocked(request);
const checkout: ProjectScopesQuery = { selection: { kind: "checkout", group_key: "group-a", project_id: "a" } };
const views = (engine = "codex", model = "old", source = "project", effort = "", options: Record<string, string> = {}): PreferenceView[] =>
  [{ key: "default_engine", value: engine, default: "", source, project_scoped: true },
    { key: "default_model", value: model, default: "", source, project_scoped: true },
    { key: "default_effort", value: effort, default: "", source, project_scoped: true },
    { key: "default_model_options", value: options, default: {}, source, project_scoped: true }];
const tuple = (engine: string, model: string, effort = "", options: Record<string, string> = {}) => ({
  default_engine: { op: "set", value: engine }, default_model: { op: "set", value: model },
  default_effort: { op: "set", value: effort }, default_model_options: { op: "set", value: options } });
const every = (edit: unknown) => ({ default_engine: edit, default_model: edit, default_effort: edit, default_model_options: edit });
let data: ScopedPreferencesResult, writes: ScopedPreferencesChange[], failure: boolean;
beforeEach(() => {
  useModelStore.setState({ byEngine: { codex: { engine: "codex", source: "engine", checked_at: "fixture", error: null, fallback: false,
    models: ["old", "chosen", "b-model", "old-reply"].map((id) => ({ id, label: id, description: null, is_default: id === "old", custom: false,
      options: id === "old" ? [
        { id: "effort", label: "Effort", values: [{ id: "low", label: "Low", default: false }, { id: "high", label: "High", default: true }] },
        { id: "service_tier", label: "Speed", values: [{ id: "fast", label: "Fast", default: false }] },
      ] : [] })),
    options: [], agents: [], output_styles: [] } satisfies EngineModels } });
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
    edits: tuple("codex", "chosen") });
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
  expect(writes[1]?.if_match).toEqual({ default_engine: "new-default_engine", default_model: "new-default_model",
    default_effort: "new-default_effort", default_model_options: "new-default_model_options" });
  expect(writes[1]?.edits.default_model).toEqual({ op: "set", value: "chosen" });
});

it("inherits the whole tuple together while Automatic sets every key explicitly", async () => {
  const user = userEvent.setup(); render(<ProjectModelDefaults query={checkout} />);
  await user.click(await screen.findByRole("button", { name: "Inherit" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.edits).toEqual(every({ op: "inherit" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Automatic" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Automatic" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]?.edits).toEqual(tuple("", ""));
});

it("does not write Mixed values on read and resets only captured tuple overrides", async () => {
  data = scopedFixture(views("codex", "old", "global"));
  data.rows = data.rows.map((row) => ({ ...row, mixed: true,
    overrides: [{ project_id: row.key === "default_engine" ? "a" : "b", name: "Overridden", value: "old" }] }));
  // Mixed effort alone still shows Mixed rather than one checkout's value.
  const user = userEvent.setup(); render(<ProjectModelDefaults query={{}} />);
  expect((await screen.findAllByRole("button", { name: "Mixed" }))[0]).toBeVisible(); expect(writes).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Reset all" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.edits).toEqual(every({ op: "reset_overrides", project_ids: ["a", "b"] }));
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

it("shows the saved unlisted model ID instead of substituting a catalog default label", async () => {
  data = scopedFixture(views("codex", "saved-unlisted"), undefined, "a");
  render(<ProjectModelDefaults query={checkout} />);
  expect(await screen.findByRole("button", { name: "saved-unlisted" })).toBeVisible();
  expect(writes).toHaveLength(0);
});

it("names an unavailable saved provider instead of presenting the representative as the saved choice", async () => {
  data = scopedFixture(views("removed-provider", "saved-model"), undefined, "a");
  render(<ProjectModelDefaults query={checkout} />);
  expect(await screen.findByRole("button", { name: "removed-provider / saved-model" })).toBeVisible();
  expect(writes).toHaveLength(0);
});

it("saves effort and options with the default model and clears them when the model changes", async () => {
  data = scopedFixture(views("codex", "old", "project", "low", { service_tier: "fast" }), undefined, "a");
  const user = userEvent.setup(); render(<ProjectModelDefaults query={checkout} />);
  const effort = await screen.findByRole("combobox", { name: "Default Effort" });
  expect(effort).toHaveValue("low");
  expect(screen.getByRole("combobox", { name: "Default Speed" })).toHaveValue("fast");
  await user.selectOptions(effort, "high");
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.edits).toEqual(tuple("codex", "old", "high", { service_tier: "fast" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Default Speed" })).toBeEnabled());
  await user.selectOptions(screen.getByRole("combobox", { name: "Default Speed" }), "");
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]?.edits).toEqual(tuple("codex", "old", "low", {}));
  await waitFor(() => expect(screen.getByRole("button", { name: /Choose model/ })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: /Choose model/ }));
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[2]?.edits).toEqual(tuple("codex", "chosen"));
});

it("offers no effort or options until a model is chosen, and shows Mixed effort without writing", async () => {
  data = scopedFixture(views("codex", ""), undefined, "a");
  const { unmount } = render(<ProjectModelDefaults query={checkout} />);
  expect(await screen.findByText("Choose a model to set its effort and options.")).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "Default Effort" })).not.toBeInTheDocument();
  unmount();
  data = scopedFixture(views("codex", "old", "global", "low"));
  data.rows = data.rows.map((row) => ({ ...row, mixed: row.key === "default_effort" }));
  render(<ProjectModelDefaults query={{}} />);
  expect(await screen.findByRole("combobox", { name: "Default Effort" })).toHaveValue("__mixed__");
  expect(writes).toHaveLength(0);
});
