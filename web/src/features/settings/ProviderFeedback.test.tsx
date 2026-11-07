import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../../api/client";
import type { EngineModels, EngineStatus } from "../../api/types";
import { ProvidersSection } from "./Providers";

const mock = vi.hoisted(() => ({ refresh: vi.fn(), engines: [] as EngineStatus[] }));
const actions = vi.hoisted(() => ({ sendFeedback: vi.fn(), models: vi.fn(), updateAllEngines: vi.fn() }));
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
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));

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
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));

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
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
    await user.click(await screen.findByRole("button", { name: "Send feedback" }));
    const dialog = await screen.findByRole("dialog");
    const send = within(dialog).getByRole("button", { name: "Send feedback" });
    await user.click(send);
    expect(send).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.click(send);
    expect(actions.sendFeedback).toHaveBeenCalledTimes(1);
    accept({ thread_id: "pending-report" });
    expect(await screen.findByRole("status")).toHaveTextContent("pending-report");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers the action only where the route exists", async () => {
    mock.engines = [engine({ id: "claude", name: "Claude" })];
    render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Claude" }));

    expect(await screen.findByRole("heading", { name: "Claude" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
  });
});

describe("update all", () => {
  const owned = { update_command: "npm install -g x@latest", latest: "2.0.0", version: "1.0.0" };

  it("offers update all for two owned engines with newer versions and reports a failure", async () => {
    const user = userEvent.setup();
    mock.engines = [
      engine({ ...owned, id: "codex", name: "Codex" }),
      engine({ ...owned, id: "claude", name: "Claude", update_command: "npm install -g y@latest" }),
      engine({ ...owned, id: "work", name: "Work", instance_of: "codex" }),
    ];
    actions.updateAllEngines.mockResolvedValue([
      { id: "codex", name: "Codex", version: "2.0.0" },
      { id: "claude", name: "Claude", error: "Claude is busy." },
    ]);
    render(<ProvidersSection />);

    await user.click(await screen.findByRole("button", { name: "Update all" }));
    const dialog = await screen.findByRole("dialog", { name: "Update 2 providers?" });
    expect(within(dialog).getByText("npm install -g x@latest")).toBeVisible();
    expect(within(dialog).getByText("npm install -g y@latest")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Update all" }));

    expect(actions.updateAllEngines).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Claude: Claude is busy.")).toBeVisible();
    await waitFor(() => expect(mock.refresh).toHaveBeenCalled());
  });

  it("does not offer update all for a single engine or one already current", async () => {
    mock.engines = [engine({ ...owned }), engine({ ...owned, id: "claude", name: "Claude", latest: "1.0.0" })];
    render(<ProvidersSection />);
    expect(await screen.findByRole("button", { name: "Check again" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Update all" })).toBeNull();
  });
});

describe("acp sign-in", () => {
  it("shows the terminal sign-in an ACP agent named, and nothing when it named none", async () => {
    const acp = { id: "opencode", name: "OpenCode", tier: "acp" as const, auth: "not_applicable" as const, installer: "unknown" as const };
    mock.engines = [engine({ ...acp, sign_in_command: "opencode acp --login" })];
    const { unmount } = render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "OpenCode" }));
    expect(await screen.findByRole("button", { name: "Copy sign-in command" })).toBeVisible();
    expect(screen.getByText("opencode acp --login")).toBeVisible();
    unmount();

    mock.engines = [engine({ ...acp, sign_in_command: null })];
    render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "OpenCode" }));
    expect((await screen.findAllByText("OpenCode")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Copy sign-in command" })).toBeNull();
  });
});
