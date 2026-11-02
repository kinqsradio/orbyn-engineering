import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { EngineStatus, JsonValue } from "../../api/types";
import { ProviderArguments, ProviderInstances } from "./ProviderInstances";
import { ProvidersSection } from "./Providers";
const mock = vi.hoisted(() => ({ refresh: vi.fn(), scope: null }));
vi.mock("../../api/client", async (original) => ({ ...await original<typeof import("../../api/client")>(), request: vi.fn() }));
vi.mock("../../state/workspace", () => ({ useWorkspace: (select: (state: { refreshEngines: typeof mock.refresh; engines: { data: EngineStatus[]; error: null } }) => unknown) => select({ refreshEngines: mock.refresh, engines: { data: [], error: null } }) }));
vi.mock("./AcpRegistry", () => ({ AcpRegistry: () => null }));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => mock.scope }));
const engines = [{ id: "claude", name: "Claude", tier: "native" }, { id: "acp-base", name: "Agent", tier: "acp" }, { id: "legacy", name: "Legacy AGUI", tier: "agui" }] as EngineStatus[];
let entries: JsonValue[], revision: string, conflict: boolean;
let writes: { scope: unknown; membership_version: string; if_match: { provider_instances: string }; edits: { provider_instances: { value: JsonValue[] } } }[];
function snapshot() { return { catalog: { version: "members-1", selection: { kind: "all_projects" } }, rows: [{ key: "provider_instances", revision, value: entries }] }; }
function mount() { return render(<ProviderInstances engines={engines} renderDriver={(engine) => <li>{engine.name} details</li>} />); }
beforeEach(() => {
  entries = [{ id: "work", driver: "claude", name: "Work", enabled: false, forward: "mine" }, { id: "other", driver: "acp-base", enabled: true, forward: { nested: true } }];
  revision = "revision-1"; conflict = false; writes = []; mock.refresh.mockReset(); mock.scope = null;
  vi.mocked(request).mockReset();
  vi.mocked(request).mockImplementation(async (method, _path, body) => {
    if (method === "POST") return snapshot() as never;
    const change = body as typeof writes[number]; writes.push(change);
    if (conflict) throw new ApiFailure("settings_conflict", "Settings changed. Reload before saving.", 409);
    expect(change.if_match.provider_instances).toBe(revision); entries = change.edits.provider_instances.value; revision = "revision-2";
    return snapshot() as never;
  });
});

describe("provider instance editor", () => {
  it("edits a disabled saved instance through environment CAS and preserves peers", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "Select Work" }));
    const name = screen.getByRole("textbox", { name: "Display name" });
    await user.clear(name); await user.type(name, " Work renamed "); await user.tab();
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ scope: {}, membership_version: "members-1", if_match: { provider_instances: "revision-1" } });
    expect(entries).toEqual([{ id: "work", driver: "claude", name: "Work renamed", enabled: false, forward: "mine" }, { id: "other", driver: "acp-base", enabled: true, forward: { nested: true } }]);
    await waitFor(() => expect(name).toHaveValue("Work renamed"));
    expect(screen.queryByRole("button", { name: "Add argument" })).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Enable Work renamed" }));
    await waitFor(() => expect(writes).toHaveLength(2)); expect((entries[0] as { enabled: boolean }).enabled).toBe(true);
  });
  it("retains a conflicted draft until explicit reload without replaying or losing foreign edits", async () => {
    const user = userEvent.setup(); mount(); await user.click(await screen.findByRole("button", { name: "Select Work" }));
    const name = screen.getByRole("textbox", { name: "Display name" });
    await user.clear(name); await user.type(name, "Draft"); conflict = true; await user.tab();
    await screen.findByRole("alert"); expect(name).toHaveValue("Draft"); expect(name).toBeDisabled(); expect(writes).toHaveLength(1);
    entries = [{ id: "work", driver: "claude", name: "External", enabled: false, forward: "newer" }, entries[1]!]; revision = "revision-newer"; conflict = false;
    await user.click(screen.getByRole("button", { name: "Reload" })); await waitFor(() => expect(name).toBeEnabled());
    expect(name).toHaveValue("Draft"); expect(writes).toHaveLength(1);
    await user.click(name); await user.keyboard("{Enter}"); await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.if_match.provider_instances).toBe("revision-newer"); expect(entries[0]).toMatchObject({ name: "Draft", forward: "newer" });
  });
  it("cancels creation without writes and adds one separately identified instance", async () => {
    const user = userEvent.setup(); mount(); const add = await screen.findByRole("button", { name: "Add provider" });
    await waitFor(() => expect(add).toBeEnabled()); await user.click(add); await user.click(screen.getByRole("button", { name: "Cancel" })); expect(writes).toHaveLength(0);
    await user.click(add); expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Legacy AGUI" })).toBeNull(); await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Studio");
    expect(screen.getByRole("textbox", { name: "Instance ID" })).toHaveValue("claude_studio");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("textbox", { name: "Binary path" }), "/private/owned-cli");
    await user.click(screen.getByRole("button", { name: "Add instance" }));
    await waitFor(() => expect(writes).toHaveLength(1)); expect(entries).toContainEqual({ id: "claude_studio", driver: "claude", enabled: true, name: "Studio", program: "/private/owned-cli" });
  });
  it("does not submit an unfinished IME display name and deletes only the selected record", async () => {
    const user = userEvent.setup(); mount(); await user.click(await screen.findByRole("button", { name: "Select Work" }));
    const name = screen.getByRole("textbox", { name: "Display name" });
    fireEvent.change(name, { target: { value: "Composing" } }); fireEvent.keyDown(name, { key: "Enter", isComposing: true }); expect(writes).toHaveLength(0);
    // Replace restored text before leaving the input: no accidental blur write.
    fireEvent.change(name, { target: { value: "Work" } });
    await user.click(screen.getByRole("button", { name: "Delete instance work" }));
    await waitFor(() => expect(writes).toHaveLength(1)); expect(entries).toEqual([{ id: "other", driver: "acp-base", enabled: true, forward: { nested: true } }]);
  });
  it("a delayed save cannot replace another instance's draft", async () => {
    const user = userEvent.setup(); mount(); await user.click(await screen.findByRole("button", { name: "Select Work" }));
    const original = vi.mocked(request).getMockImplementation()!;
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(request).mockImplementation(async (...args) => { const result = await original(...args); if (args[0] === "PUT") await held; return result; });
    const name = screen.getByRole("textbox", { name: "Display name" }); await user.clear(name); await user.type(name, "Saved work"); await user.tab();
    await waitFor(() => expect(writes).toHaveLength(1)); await user.click(screen.getByRole("button", { name: "Select other" }));
    const other = screen.getByRole("textbox", { name: "Display name" }); expect(other).toHaveValue("");
    await act(async () => release()); await waitFor(() => expect(other).toBeEnabled()); expect(other).toHaveValue("");
    expect(screen.getByRole("button", { name: "Delete instance other" })).toBeVisible();
  });
  it("does not hide the entire configuration owner when the ready live catalog is empty", async () => {
    const user = userEvent.setup(); render(<ProvidersSection />);
    const add = await screen.findByRole("button", { name: "Add provider" }); await waitFor(() => expect(add).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Select Work" }));
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Work");
  });
  it("keeps disabled configuration and creation reachable with no live providers", async () => {
    const user = userEvent.setup();
    render(<ProviderInstances engines={[]} renderDriver={() => null} />);
    const add = await screen.findByRole("button", { name: "Add provider" });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Select Work" }));
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Work");
    await user.click(add); await user.click(screen.getByRole("button", { name: "Local ACP command" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Executable" }), "/owned/agent");
    await user.click(screen.getByRole("button", { name: "Add argument" }));
    await user.type(screen.getByRole("textbox", { name: "Argument 1" }), "two literal words");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Local work");
    expect(screen.queryByRole("textbox", { name: "Protocol" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add instance" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(entries).toContainEqual({ id: "acp_local_work", driver: "_local_acp", name: "Local work", program: "/owned/agent", args: ["two literal words"], enabled: true });
    expect(screen.getByRole("textbox", { name: "Executable" })).toHaveValue("/owned/agent");
  });
  it("passes the effective instance identity to status and Models consumers without a base removal control", async () => {
    const user = userEvent.setup();
    const named = { id: "other", name: "Agent work", instance_of: "acp-base", tier: "acp" } as EngineStatus;
    render(<ProviderInstances engines={[...engines, named]} renderDriver={() => null}
      renderStatus={(engine) => <span>Status for {engine.id}</span>}
      renderInstance={(engine) => <section aria-label={`Models for ${engine.id}`}>Models</section>} />);
    await user.click(await screen.findByRole("button", { name: "Select other" }));
    expect(screen.getByText("Status for other")).toBeVisible();
    expect(screen.getByRole("region", { name: "Models for other" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove Agent work" })).toBeNull();
  });
  it("keeps each launch argument literal rather than splitting on spaces", async () => {
    let values = ["--label", "two words"];
    const save = vi.fn(async (next: string[]) => { values = next; return true; });
    render(<ProviderArguments values={values} disabled={false} save={save} />);
    await act(async () => fireEvent.change(screen.getByRole("textbox", { name: "Argument 2" }), { target: { value: "three literal words" } }));
    fireEvent.blur(screen.getByRole("textbox", { name: "Argument 2" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(["--label", "three literal words"]));
  });
});
