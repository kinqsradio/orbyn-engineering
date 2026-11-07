import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { EngineStatus, JsonValue } from "../../api/types";
import { ProvidersSection } from "./Providers";

const mock = vi.hoisted(() => ({ refresh: vi.fn(), engines: [] as EngineStatus[] }));
vi.mock("../../api/client", async (original) => ({ ...await original<typeof import("../../api/client")>(), request: vi.fn() }));
vi.mock("../../state/workspace", () => ({
  useWorkspace: (select: (state: unknown) => unknown) => select({ refreshEngines: mock.refresh, engines: { data: mock.engines, error: null }, projects: { data: [], error: null } }),
}));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => null }));
const base = { capabilities: {}, installed: true, version: "2.1.318", auth: "logged_in", latest: null, support: "tested", update_command: null, sign_in_command: null, updating: false, problem: null } as const;
const engine = (patch: Partial<EngineStatus>) => ({ ...base, ...patch }) as EngineStatus;
let entries: JsonValue[], revision: string, conflict: string | null;
let writes: { scope: unknown; membership_version: string; if_match: { provider_instances: string }; edits: { provider_instances: { value: JsonValue[] } } }[];
function snapshot() { return { catalog: { version: "members-1", selection: { kind: "all_projects" } }, rows: [{ key: "provider_instances", revision, value: entries }] }; }
beforeEach(() => {
  mock.engines = [
    engine({ id: "claude", name: "Claude Code", tier: "native", path: "/opt/claude" }),
    engine({ id: "work", name: "Claude Code · Work", tier: "native", path: "/opt/work", instance_of: "claude" }),
    engine({ id: "acp-base", name: "Agent", tier: "acp", path: "/opt/agent" }),
  ];
  entries = [{ id: "work", driver: "claude", name: "Work", enabled: false, forward: "mine", program: "/opt/work" }, { id: "other", driver: "acp-base", enabled: true, forward: { nested: true } }];
  revision = "revision-1"; conflict = null; writes = []; mock.refresh.mockReset();
  vi.mocked(request).mockReset();
  vi.mocked(request).mockImplementation(async (method, _path, body) => {
    if (method === "POST") return snapshot() as never;
    const change = body as typeof writes[number]; writes.push(change);
    if (conflict) throw new ApiFailure("invalid_path", conflict, 400);
    entries = change.edits.provider_instances.value; revision = "revision-2";
    return snapshot() as never;
  });
});

describe("provider instance dialog", () => {
  it("keeps Save off until something changes, then saves through environment CAS and keeps peers", async () => {
    const user = userEvent.setup(); render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Edit Claude Code · Work" }));
    const dialog = await screen.findByRole("dialog", { name: /Edit/ });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    const name = within(dialog).getByRole("textbox", { name: "Display name" });
    await user.clear(name); await user.type(name, "Work renamed");
    await user.click(within(dialog).getByRole("button", { name: "Colour #3b82f6" }));
    await user.click(save);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ scope: {}, membership_version: "members-1", if_match: { provider_instances: "revision-1" } });
    expect(entries).toEqual([{ id: "work", driver: "claude", name: "Work renamed", accent: "#3b82f6", enabled: false, forward: "mine", program: "/opt/work" }, { id: "other", driver: "acp-base", enabled: true, forward: { nested: true } }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("saves a Claude auto-compact window only inside its range", async () => {
    const user = userEvent.setup(); render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Edit Claude Code · Work" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByRole("textbox", { name: "Auto-compact after" });
    await user.type(field, "99999");
    expect(within(dialog).getByText("Use 100000 to 1000000.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(field); await user.type(field, "300000");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(entries[0]).toMatchObject({ auto_compact_window: "300000" }));
  });
  it("names the reason under the path when the save is refused and leaves the list alone", async () => {
    const user = userEvent.setup(); conflict = "No file at this path.";
    render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Edit Claude Code · Work" }));
    const dialog = await screen.findByRole("dialog");
    const path = within(dialog).getByRole("textbox", { name: "Binary path" });
    await user.clear(path); await user.type(path, "/opt/claud");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("No file at this path.")).toBeVisible();
    expect(path).toBeInvalid();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });
  it("turns an instance in use on or off from the list", async () => {
    const user = userEvent.setup(); render(<ProvidersSection />);
    await user.click(await screen.findByRole("switch", { name: "Enable Claude Code · Work" }));
    await waitFor(() => expect((entries[0] as { enabled: boolean }).enabled).toBe(true));
    expect(screen.queryByRole("switch", { name: "Enable Claude Code" })).toBeNull();
  });
  it("offers Edit on instances only", async () => {
    render(<ProvidersSection />);
    await screen.findByRole("button", { name: "Edit Claude Code · Work" });
    expect(screen.queryByRole("button", { name: "Edit Claude Code" })).toBeNull();
  });
});

describe("provider pages", () => {
  it("adds an instance from what was found, with the path filled in", async () => {
    const user = userEvent.setup(); render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Add provider" }));
    const choose = await screen.findByRole("dialog", { name: "Add a provider" });
    expect(within(choose).getByText("Found at /opt/claude · 2.1.318")).toBeVisible();
    await user.click(within(choose).getByRole("button", { name: "Continue" }));
    const editor = await screen.findByRole("dialog", { name: "Add Claude Code" });
    expect(within(editor).getByRole("textbox", { name: "Binary path" })).toHaveValue("/opt/claude");
    await user.type(within(editor).getByRole("textbox", { name: "Display name" }), "Personal");
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(entries).toHaveLength(3));
    expect(entries[2]).toMatchObject({ id: "claude_personal", driver: "claude", name: "Personal", program: "/opt/claude", enabled: true });
  });
  it("opens a provider and returns with the back link", async () => {
    const user = userEvent.setup(); render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Claude Code · Work" }));
    expect(await screen.findByRole("heading", { name: "Claude Code · Work" })).toBeVisible();
    expect(screen.getByText("/opt/work")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Providers" }));
    expect(await screen.findByRole("table", { name: "Providers" })).toBeVisible();
  });
  it("removes only the selected instance record", async () => {
    const user = userEvent.setup(); render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Claude Code · Work" }));
    await user.click(await screen.findByRole("button", { name: "Remove Claude Code · Work" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove provider" }));
    await waitFor(() => expect(entries).toEqual([{ id: "other", driver: "acp-base", enabled: true, forward: { nested: true } }]));
  });
});
