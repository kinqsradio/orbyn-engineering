import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, request } from "../../api/client";
import type { EngineStatus, PreferenceView, Project, Run, Thread } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { DRAFT_KEY } from "../../state/draftStore";
import { DraftView } from "./DraftView";

vi.mock("../../api/client", async (original) => {
  const actual = await original<typeof import("../../api/client")>();
  return { ...actual, request: vi.fn(), api: { ...actual.api, createThread: vi.fn(), startRun: vi.fn() } };
});
vi.mock("../../app/shortcuts", () => ({ useCommand: () => undefined }));
vi.mock("../workspace/GitHubStarPrompt", () => ({ recordUserPrompt: () => undefined }));
vi.mock("./useDraftCheckout", () => ({ useDraftCheckout: () => ({ worktree: null, setWorktree: () => undefined, loading: false, error: null }) }));
vi.mock("../../state/modelStore", () => ({ useEngineModels: () => null, resolveModel: () => null }));
vi.mock("../thread/ComposerTraits", () => ({
  ACCESS: { supervised: { label: "Supervised", icon: () => null } },
  EffortTrigger: () => null,
  offeredModes: () => ["supervised"],
  shownAccess: (_engine: unknown, saved: string) => saved,
  useTraitsMenu: () => ({ menu: null, openAt: () => undefined }),
}));
vi.mock("../thread/ModelPicker", () => ({ ModelPickerTrigger: ({ selected, onPick }: {
  selected: { engine: string; model: string | null }; onPick(choice: { engine: string; model: string }): void;
}) => <button type="button" onClick={() => onPick({ engine: "codex", model: "explicit" })}>
  Model {selected.engine}/{selected.model ?? "automatic"}</button> }));

const defaults = (model: string): PreferenceView[] => [
  { key: "default_engine", value: "codex", default: "", source: "project", project_scoped: true },
  { key: "default_model", value: model, default: "", source: "project", project_scoped: true },
  { key: "disabled_engines", value: [], default: [], source: "default", project_scoped: true },
];
beforeEach(() => {
  vi.mocked(request).mockReset();
  vi.mocked(api.createThread).mockReset().mockResolvedValue({ id: "created", project_id: "a", title: "Thread" } as Thread);
  vi.mocked(api.startRun).mockReset().mockResolvedValue({ id: "run" } as Run);
  useWorkspace.setState({
    projects: { data: [{ id: "a", name: "Fixture", trusted: true, is_git: true, path: "/fixture/a" } as Project], loading: false, error: null },
    engines: { data: [{ id: "codex", name: "Codex", auth: "logged_in", installed: true, capabilities: { managed: true } } as EngineStatus], loading: false, error: null },
    putThread: vi.fn(),
  });
  useUi.setState({ lastModel: { engine: "codex", model: "remembered", effort: "high" },
    drafts: { [DRAFT_KEY]: "Fixture prompt" } });
});

it("sends the project default from the real draft handler instead of the remembered model", async () => {
  vi.mocked(request).mockResolvedValue(defaults("project-model") as never);
  render(<DraftView projectId="a" />);
  const send = screen.getByRole("button", { name: "Send" });
  await waitFor(() => expect(send).toBeEnabled());
  await userEvent.setup().click(send);
  await waitFor(() => expect(api.createThread).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.createThread).mock.calls[0]?.[0]).toMatchObject({ project_id: "a", engine: "codex", model: "project-model" });
  expect(vi.mocked(api.startRun).mock.calls[0]?.[3]).toEqual({});
});

it("keeps an explicit draft model when defaults arrive later, then sends that explicit model", async () => {
  let done!: (value: PreferenceView[]) => void;
  vi.mocked(request).mockImplementation(() => new Promise((resolve) => { done = resolve; }) as never);
  render(<DraftView projectId="a" />);
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Model codex/remembered" }));
  await act(async () => done(defaults("late-default")));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "Model codex/explicit" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.createThread).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.createThread).mock.calls[0]?.[0].model).toBe("explicit");
});

it("keeps a missing configured provider blocked until the person explicitly chooses a replacement", async () => {
  const missing = defaults("missing-model"); missing[0]!.value = "removed-provider";
  vi.mocked(request).mockResolvedValue(missing as never);
  render(<DraftView projectId="a" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("selected default provider is unavailable");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(api.createThread).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Model codex/automatic" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.createThread).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.createThread).mock.calls[0]?.[0]).toMatchObject({ engine: "codex", model: "explicit" });
});

it("shows no side panel and no launcher on a draft, even when the panel preference is open", () => {
  vi.mocked(request).mockResolvedValue(defaults("project-model") as never);
  useUi.setState({ panelOpen: true });
  render(<DraftView projectId="a" />);
  expect(screen.queryByRole("complementary", { name: "Thread context" })).toBeNull();
  expect(screen.queryByText("Open a surface")).toBeNull();
  expect(screen.queryByRole("button", { name: "Surfaces" })).toBeNull();
});
