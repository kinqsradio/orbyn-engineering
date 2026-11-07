import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { EngineStatus } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { engineReadiness, WelcomeWizard } from "./WelcomeWizard";

const saved: unknown[] = [];
vi.mock("../../api/client", async (original) => {
  const actual = await original<typeof import("../../api/client")>();
  return {
    ...actual,
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === "/api/settings/preferences/query")
        return { catalog: { version: "v1" }, rows: [{ key: "default_permission_mode", value: "supervised", revision: "r1" }] };
      if (path === "/api/settings/preferences" && method === "PUT") {
        saved.push(body);
        return { catalog: { version: "v2" }, rows: [] };
      }
      if (path === "/api/skills") return { skills: [] };
      return [];
    }),
    api: { ...actual.api, browse: vi.fn(async () => ({ path: "/home/dev", parent: null, entries: [] })), skills: vi.fn(async () => ({ skills: [] })),
      addProject: vi.fn(async (path: string) => ({ id: "p1", name: "site", path, trusted: true, is_git: true, created_at: "", managed: false, scratch: false })),
    },
  };
});

const engine = (patch: Partial<EngineStatus>) => ({
  id: "claude", name: "Claude", tier: "managed", installed: true, auth: "logged_in", version: "2.1.0",
  manual_hint: "npm install -g claude", sign_in_command: "claude login",
  capabilities: { permission_modes: ["supervised", "auto_edits", "auto", "full_access"] }, ...patch,
}) as EngineStatus;

beforeEach(() => {
  useUi.getState().setPrefs({ welcomeDone: false });
  useUi.getState().setWelcomeStep(0);
});

it("names what each engine still needs", () => {
  expect(engineReadiness(engine({})).label).toBe("Ready");
  expect(engineReadiness(engine({ auth: "logged_out" }))).toMatchObject({ label: "Sign in needed", next: "claude login" });
  // The manual hint says how to update, which is no help before the engine exists.
  expect(engineReadiness(engine({ installed: false }))).toMatchObject({ label: "Not installed", next: null, step: "Install Claude, then check again." });
});

it("walks the overview, agents, projects and access, saving the chosen access mode", async () => {
  const user = userEvent.setup();
  useWorkspace.setState({
    engines: {
      data: [engine({ capabilities: { permission_modes: ["supervised", "auto", "full_access"] } as EngineStatus["capabilities"] }), engine({ id: "codex", name: "Codex", auth: "logged_out" })],
      error: null,
      loading: false,
    },
  });
  const onClose = vi.fn();
  render(<WelcomeWizard onClose={onClose} />);
  expect(screen.getByRole("heading", { name: "Welcome to Orbyn Engineering" })).toBeInTheDocument();
  expect(screen.getByText("Supervised, Auto-accept edits, Auto or Full access")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Start" }));
  expect(screen.getByRole("img", { name: "Step 1 of 3" })).toBeInTheDocument();
  expect(screen.getByText("Ready")).toBeInTheDocument();
  // A signed-out agent shows the command to run, with a Copy action, and keeps Check again on offer.
  expect(screen.getByText("claude login")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy the Codex command" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("img", { name: "Step 2 of 3" })).toBeInTheDocument();
  expect(screen.getByLabelText("Folder path")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Clone a repository/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(screen.getByRole("img", { name: "Step 3 of 3" })).toBeInTheDocument();
  // Only the modes the chosen engine supports are offered, and Plan never is.
  expect(screen.getAllByRole("radio").map((radio) => radio.closest("label")?.querySelector("b")?.textContent)).toEqual(["Supervised", "Auto", "Full access"]);
  await user.click(screen.getByRole("radio", { name: /Full access/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(saved[0]).toMatchObject({ edits: { default_permission_mode: { op: "set", value: "full_access" } } });
  expect(useUi.getState().welcomeDone).toBe(true);
  expect(useUi.getState().welcomeStep).toBeNull();
});

it("keeps Continue off until a project is added, then lists it under Added and drops Skip for now", async () => {
  const user = userEvent.setup();
  useUi.getState().setWelcomeStep(2);
  render(<WelcomeWizard onClose={() => undefined} />);
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  expect(screen.getByText("You can import past agent sessions later in Settings › Providers.")).toBeInTheDocument();
  await user.type(screen.getByLabelText("Folder path"), "{Enter}");
  expect(await screen.findByText("Added")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  // Adding does not leave the step: the wizard stays until Continue.
  expect(useUi.getState().welcomeStep).toBe(2);
});

it("drops Check again once every agent is ready", async () => {
  const user = userEvent.setup();
  useWorkspace.setState({ engines: { data: [engine({})], error: null, loading: false } });
  render(<WelcomeWizard onClose={() => undefined} />);
  await user.click(screen.getByRole("button", { name: "Start" }));
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
});

it("skips from the overview and remembers it", async () => {
  const user = userEvent.setup();
  render(<WelcomeWizard onClose={() => undefined} />);
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(useUi.getState().welcomeDone).toBe(true);
  expect(useUi.getState().welcomeStep).toBeNull();
});
