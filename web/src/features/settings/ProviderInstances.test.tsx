import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiFailure, request } from "../../api/client";
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
let inUseWrites: JsonValue[][] = [];
let writes: { scope: unknown; membership_version: string; if_match: { provider_instances: string }; edits: { provider_instances: { value: JsonValue[] } } }[];
function snapshot() { return { catalog: { version: "members-1", selection: { kind: "all_projects" } }, rows: [{ key: "provider_instances", revision, value: entries }] }; }
beforeEach(() => {
  vi.restoreAllMocks();
  mock.engines = [
    engine({ id: "claude", name: "Claude Code", tier: "native", path: "/opt/claude" }),
    engine({ id: "work", name: "Claude Code · Work", tier: "native", path: "/opt/work", instance_of: "claude" }),
    engine({ id: "acp-base", name: "Agent", tier: "acp", path: "/opt/agent" }),
  ];
  entries = [{ id: "work", driver: "claude", name: "Work", enabled: false, forward: "mine", program: "/opt/work" }, { id: "other", driver: "acp-base", enabled: true, forward: { nested: true } }];
  revision = "revision-1"; conflict = null; writes = []; inUseWrites = []; mock.refresh.mockReset();
  vi.mocked(request).mockReset();
  vi.mocked(request).mockImplementation(async (method, _path, body) => {
    const wanted = (body as { keys?: string[]; edits?: Record<string, { value: JsonValue[] }> });
    if (method === "POST" && wanted.keys?.[0] === "disabled_engines") return { catalog: { version: "members-1", selection: { kind: "all_projects" } }, rows: [{ key: "disabled_engines", revision: "r", value: [], mixed: false, default: [], project_scoped: true, environment: { source: "default", value: [], default: [] }, members: [], overrides: [] }] } as never;
    if (method === "PUT" && wanted.edits?.disabled_engines) { inUseWrites.push(wanted.edits.disabled_engines.value); return {} as never; }
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
    const field = within(dialog).getByRole("textbox", { name: "Auto-compact window" });
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
  const openPath = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Edit Claude Code · Work" }));
    const dialog = await screen.findByRole("dialog");
    return { dialog, path: within(dialog).getByRole("textbox", { name: "Binary path" }), save: () => within(dialog).getByRole("button", { name: "Save" }) };
  };
  it("runs the program check when you leave the path field, not while you type", async () => {
    const user = userEvent.setup();
    const probe = vi.spyOn(api, "probeBinary").mockResolvedValue({ exists: true, path: "/opt/work2", version: "2.1.318", problem: null });
    const { dialog, path } = await openPath(user);
    await user.clear(path); await user.type(path, "/opt/work2");
    expect(probe).not.toHaveBeenCalled();
    await user.tab();
    expect(await within(dialog).findByText("Found. Version 2.1.318.")).toBeVisible();
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it("saves a bare program name the engines find on PATH", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "probeBinary").mockResolvedValue({ exists: false, path: null, version: null, problem: "Give the full path to the program." });
    const { dialog, path, save } = await openPath(user);
    await user.clear(path); await user.type(path, "my-agent"); await user.tab();
    expect(await within(dialog).findByText("Give the full path to the program.")).toBeVisible();
    expect(save()).toBeEnabled();
  });
  it("blocks Save on an absolute path with no file", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "probeBinary").mockResolvedValue({ exists: false, path: null, version: null, problem: "No file at this path." });
    const { dialog, path, save } = await openPath(user);
    await user.clear(path); await user.type(path, "/opt/claud"); await user.tab();
    expect(await within(dialog).findByText("No file at this path.")).toBeVisible();
    expect(save()).toBeDisabled();
  });
  it("does not block Save when the program exists but its version check fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "probeBinary").mockResolvedValue({ exists: true, path: "/opt/work2", version: null, problem: "Its version command failed." });
    const { dialog, path, save } = await openPath(user);
    await user.clear(path); await user.type(path, "/opt/work2"); await user.tab();
    expect(await within(dialog).findByText("Its version command failed.")).toBeVisible();
    expect(save()).toBeEnabled();
  });
  it("turns a provider in use on or off for the scope, through the providers-in-use preference", async () => {
    const user = userEvent.setup(); render(<ProvidersSection />);
    const toggle = await screen.findByRole("switch", { name: "Use Claude Code · Work" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    await waitFor(() => expect(inUseWrites).toEqual([["work"]]));
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
  it("names who is signed in under each provider, and the instance beside it", async () => {
    mock.engines = [engine({ id: "claude", name: "Claude Code", tier: "native", account: "sam@example.com" }),
      engine({ id: "work", name: "Claude Code · Work", tier: "native", instance_of: "claude", account: "sam@acme.com" }),
      engine({ id: "codex", name: "Codex", tier: "native", auth: "logged_out" })];
    render(<ProvidersSection />);
    expect(await screen.findByText("sam@example.com")).toBeVisible();
    expect(screen.getByText("Work · sam@acme.com")).toBeVisible();
    expect(screen.getByText("Not signed in")).toBeVisible();
  });
  it("shows the signed-in account on the provider's page", async () => {
    const user = userEvent.setup();
    mock.engines = [engine({ id: "claude", name: "Claude Code", tier: "native", account: "sam@example.com" })];
    render(<ProvidersSection />);
    await user.click(await screen.findByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText("Signed in as sam@example.com")).toBeVisible();
  });
  it("offers Review with the count of sessions the service finds, and opens the history import", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "nativeSessionCount").mockImplementation(async (id) => ({ engine: id, count: id === "claude" ? 12 : 6, truncated: false }));
    mock.engines = [engine({ id: "claude", name: "Claude Code", tier: "native" }), engine({ id: "codex", name: "Codex", tier: "native" })];
    render(<ProvidersSection />);
    expect(await screen.findByText("Provider sessions this computer keeps")).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Review 18" }));
    expect(await screen.findByRole("button", { name: "Providers" })).toBeVisible();
  });
  it("marks the count as a lower bound when the history folder was too large to count to the end", async () => {
    vi.spyOn(api, "nativeSessionCount").mockImplementation(async (id) => ({ engine: id, count: id === "claude" ? 12 : 0, truncated: id === "claude" }));
    mock.engines = [engine({ id: "claude", name: "Claude Code", tier: "native" }), engine({ id: "codex", name: "Codex", tier: "native" })];
    render(<ProvidersSection />);
    expect(await screen.findByRole("button", { name: "Review 12+" })).toBeVisible();
  });
  it("still shows Native sessions when only one engine fails to count", async () => {
    vi.spyOn(api, "nativeSessionCount").mockImplementation(async (id) => {
      if (id === "codex") throw new ApiFailure("unsupported", "No history folder.", 400);
      return { engine: id, count: 12, truncated: false };
    });
    render(<ProvidersSection />);
    expect(await screen.findByRole("button", { name: "Review 12" })).toBeVisible();
  });
  it("hides Native sessions when the service has no count to give", async () => {
    vi.spyOn(api, "nativeSessionCount").mockRejectedValue(new ApiFailure("unsupported", "No history folder.", 400));
    render(<ProvidersSection />);
    await screen.findByRole("table", { name: "Providers" });
    expect(screen.queryByText("Native sessions")).toBeNull();
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
