import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineModels, EngineStatus } from "../../api/types";
import { ProvidersSection } from "./Providers";

const mock = vi.hoisted(() => ({ refresh: vi.fn(), engines: [] as EngineStatus[] }));
const actions = vi.hoisted(() => ({ installRecommended: vi.fn(), updateEngine: vi.fn(), models: vi.fn() }));
vi.mock("../../api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/client")>();
  return { ...original, api: { ...original.api, ...actions } };
});
vi.mock("../../state/workspace", () => ({
  useWorkspace: (select: (state: {
    refreshEngines: typeof mock.refresh;
    engines: { data: EngineStatus[]; error: null };
    projects: { data: unknown[]; error: null };
  }) => unknown) =>
    select({
      refreshEngines: mock.refresh,
      engines: { data: mock.engines, error: null },
      projects: { data: [], error: null },
    }),
}));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => null }));

const rangeWarning =
  "This engine version is outside the supported range for this Orbyn release. Use 0.166.0.";
const catalog: EngineModels = {
  engine: "codex", source: "engine", models: [], error: null,
  checked_at: "2026-11-05T00:00:00Z", fallback: false, options: [], agents: [],
  output_styles: [],
};

function engine(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    id: "codex",
    name: "Codex",
    tier: "native",
    capabilities: {
      managed: true, streaming: true, approvals: true, resume: true, mcp: true,
      sandbox: true, skill_delivery: [], goal_control: true, decline_feedback: false,
    permission_modes: ["supervised", "auto_edits", "auto", "full_access"],
    },
    installed: true,
    path: "/engine",
    version: "0.160.0",
    auth: "logged_in",
    installer: "npm",
    latest: null,
    support: "below_minimum",
    update_command: "npm install -g @openai/codex@latest",
    manual_hint: "Update Codex with the installer you used, then refresh.",
    sign_in_command: null,
    updating: false,
    problem: null,
    ...overrides,
  };
}

beforeEach(() => {
  mock.refresh.mockReset();
  actions.installRecommended.mockReset();
  actions.updateEngine.mockReset();
  actions.models.mockReset();
  actions.models.mockResolvedValue(catalog);
});

describe("provider compatibility warning", () => {
  it("offers the recommended version through the installer that owns the binary", async () => {
    const user = userEvent.setup();
    mock.engines = [engine({
      compatibility: {
        status: "unsupported",
        message: rangeWarning,
        recommended_version: "0.166.0",
        recommended_command: "npm install -g @openai/codex@0.166.0",
      },
    })];
    render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));

    expect(await screen.findByText(rangeWarning)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Install 0.166.0" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("npm install -g @openai/codex@0.166.0")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Install 0.166.0" }));
    await waitFor(() => expect(actions.installRecommended).toHaveBeenCalledWith("codex"));
    expect(actions.updateEngine).not.toHaveBeenCalled();
    expect(mock.refresh).toHaveBeenCalled();
  });

  it("keeps manual instructions when no installer can pin the version", async () => {
    mock.engines = [engine({
      compatibility: { status: "unsupported", message: rangeWarning, recommended_version: "0.166.0" },
    })];
    render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));

    expect(await screen.findByText(rangeWarning)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Install 0.166.0" })).toBeNull();
    expect(
      screen.getByText("Install 0.166.0 with the installer that owns this engine. Update Codex with the installer you used, then refresh."),
    ).toBeVisible();
    // The installer it did prove is still offered.
    expect(screen.getByRole("button", { name: "Update" })).toBeVisible();
  });

  it("says nothing about a version the signed manifest does not flag", async () => {
    mock.engines = [engine({ version: "0.166.0", support: "tested", latest: "0.170.0" })];
    render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));

    expect(await screen.findByRole("button", { name: "Update to 0.170.0" })).toBeVisible();
    expect(screen.queryByText(rangeWarning)).toBeNull();
  });
});
