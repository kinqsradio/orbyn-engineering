import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineModels, EngineStatus } from "../../api/types";
import { ApiFailure } from "../../api/client";
import { useEngineUpdates } from "./engineUpdates";
import { ProvidersSection } from "./Providers";

const mock = vi.hoisted(() => ({ refresh: vi.fn(), engines: [] as EngineStatus[] }));
const actions = vi.hoisted(() => ({ models: vi.fn(), updateEngine: vi.fn() }));
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
    latest: "0.167.0",
    support: "tested",
    update_command: "npm install -g @openai/codex@latest",
    manual_hint: "Update Codex with the installer you used, then refresh.",
    sign_in_command: null,
    updating: false,
    problem: null,
    ...overrides,
  };
}

/** A fetch whose update stream sends what the test writes to it. */
function stream() {
  let send: (text: string) => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      send = (text) => controller.enqueue(encoder.encode(text));
    },
  });
  const fetch = vi.fn(async (url: string) =>
    url.endsWith("/api/engines/update-events")
      ? new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      : new Response("{}", { status: 404 }),
  );
  vi.stubGlobal("fetch", fetch);
  return { fetch, event: (value: object) => act(() => send(`data: ${JSON.stringify(value)}\n\n`)) };
}

beforeEach(() => {
  mock.refresh.mockReset();
  actions.models.mockReset();
  actions.updateEngine.mockReset();
  useEngineUpdates.getState().clear();
  actions.models.mockResolvedValue(catalog);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider update progress", () => {
  it("shows the installer's latest line while the update runs", async () => {
    const updates = stream();
    mock.engines = [engine()];
    render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
    await waitFor(() => expect(updates.fetch).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Update to 0.167.0" })).toBeVisible();

    await updates.event({ kind: "started", engine: "codex", command: "npm install -g @openai/codex@latest" });
    expect(await screen.findByText("npm install -g @openai/codex@latest")).toBeVisible();
    expect(screen.getByText("Updating")).toBeVisible();
    await updates.event({ kind: "output", engine: "codex", line: "added 1 package in 3s" });
    expect(await screen.findByText("added 1 package in 3s")).toBeVisible();
    expect(screen.queryByText("npm install -g @openai/codex@latest")).toBeNull();

    await updates.event({ kind: "finished", engine: "codex", version: "0.167.0", error: null });
    await waitFor(() => expect(screen.queryByText("added 1 package in 3s")).toBeNull());
    expect(screen.queryByText("Updating")).toBeNull();
  });

  it("keeps the update dialog open with the line, then its error", async () => {
    const user = userEvent.setup();
    const updates = stream();
    let fail: (error: Error) => void = () => {};
    actions.updateEngine.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    mock.engines = [engine()];
    render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
    await waitFor(() => expect(updates.fetch).toHaveBeenCalled());
    await user.click(await screen.findByRole("button", { name: "Update to 0.167.0" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(actions.updateEngine).toHaveBeenCalledWith("codex"));

    await updates.event({ kind: "started", engine: "codex", command: "npm install -g @openai/codex@latest" });
    await updates.event({ kind: "output", engine: "codex", line: "npm error code EACCES" });
    expect(await within(dialog).findByText("npm error code EACCES")).toBeVisible();
    await updates.event({ kind: "finished", engine: "codex", version: null, error: "The update failed." });
    await act(async () => fail(new ApiFailure("update_failed", "The update failed.", 422)));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("The update failed.");
  });

  it("ignores another engine's update", async () => {
    const updates = stream();
    mock.engines = [engine()];
    render(<ProvidersSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Codex" }));
    await waitFor(() => expect(updates.fetch).toHaveBeenCalled());
    await updates.event({ kind: "output", engine: "claude", line: "changed 3 packages" });
    expect(screen.queryByText("changed 3 packages")).toBeNull();
    expect(screen.getByRole("button", { name: "Update to 0.167.0" })).toBeVisible();
  });
});
