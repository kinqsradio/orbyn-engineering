import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../../api/client";
import type { EngineModels, EngineStatus } from "../../api/types";
import { ProvidersSection } from "./Providers";

const mock = vi.hoisted(() => ({ refresh: vi.fn(), engines: [] as EngineStatus[] }));
const actions = vi.hoisted(() => ({ sendFeedback: vi.fn(), models: vi.fn() }));
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
vi.mock("./AcpRegistry", () => ({ AcpRegistry: () => null }));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => null }));

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
    version: "0.166.0",
    auth: "logged_in",
    installer: "npm",
    latest: null,
    support: "tested",
    update_command: null,
    manual_hint: null,
    sign_in_command: null,
    updating: false,
    problem: null,
    ...overrides,
  };
}

beforeEach(() => {
  mock.refresh.mockReset();
  actions.sendFeedback.mockReset();
  actions.models.mockReset();
  actions.models.mockResolvedValue(catalog);
});

describe("codex feedback", () => {
  it("sends the written reason and the chosen log setting", async () => {
    const user = userEvent.setup();
    mock.engines = [engine()];
    actions.sendFeedback.mockResolvedValue({ thread_id: "report-1", prompt_hash: null });
    render(<ProvidersSection />);

    await user.click(await screen.findByRole("button", { name: "Send feedback" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/goes to OpenAI through Codex/)).toBeVisible();
    const logs = within(dialog).getByRole("switch", { name: "Include Codex logs" });
    expect(logs).not.toBeChecked();
    await user.type(within(dialog).getByLabelText("What went wrong? (optional)"), "  it broke  ");
    await user.click(logs);
    await user.click(within(dialog).getByRole("button", { name: "Send feedback" }));

    await waitFor(() =>
      expect(actions.sendFeedback).toHaveBeenCalledWith("codex", {
        reason: "it broke",
        include_logs: true,
        thread_id: null,
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("report-1");
  });

  it("keeps the dialog open and reports a failed send", async () => {
    const user = userEvent.setup();
    mock.engines = [engine()];
    actions.sendFeedback.mockRejectedValue(
      new ApiFailure("unsupported", "Codex refused the report.", 422),
    );
    render(<ProvidersSection />);

    await user.click(await screen.findByRole("button", { name: "Send feedback" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Send feedback" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Codex refused the report.");
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("blocks duplicate sends and closing while the report is pending", async () => {
    const user = userEvent.setup();
    mock.engines = [engine()];
    let accept!: (receipt: { thread_id: string }) => void;
    actions.sendFeedback.mockReturnValue(new Promise((resolve) => { accept = resolve; }));
    render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Send feedback" }));
    const dialog = await screen.findByRole("dialog");
    const send = within(dialog).getByRole("button", { name: "Send feedback" });
    await user.click(send);
    expect(send).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    await user.click(send);
    expect(actions.sendFeedback).toHaveBeenCalledTimes(1);
    accept({ thread_id: "pending-report" });
    expect(await screen.findByRole("status")).toHaveTextContent("pending-report");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers the action only where the route exists", async () => {
    mock.engines = [engine({ id: "claude", name: "Claude" })];
    render(<ProvidersSection />);

    expect(await screen.findByRole("heading", { name: "Claude" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
  });
});
