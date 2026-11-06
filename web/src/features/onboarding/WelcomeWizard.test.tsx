import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { EngineStatus } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { engineReadiness, WelcomeWizard } from "./WelcomeWizard";

vi.mock("../../api/client", async (original) => {
  const actual = await original<typeof import("../../api/client")>();
  return { ...actual, request: vi.fn(async () => ({ sessions: [], truncated: false })) };
});

const engine = (patch: Partial<EngineStatus>) => ({
  id: "claude", name: "Claude", tier: "managed", installed: true, auth: "logged_in", version: "2.1.0",
  manual_hint: "npm install -g claude", sign_in_command: "claude login", ...patch,
}) as EngineStatus;

beforeEach(() => {
  useUi.getState().setPrefs({ welcomeDone: false });
  useUi.getState().setWelcomeStep(0);
});

it("names what each engine still needs", () => {
  expect(engineReadiness(engine({})).label).toBe("Ready");
  expect(engineReadiness(engine({ auth: "logged_out" }))).toMatchObject({ label: "Sign in needed", next: "claude login" });
  expect(engineReadiness(engine({ installed: false }))).toMatchObject({ label: "Not installed", next: "npm install -g claude" });
});

it("walks agents then projects and remembers it was finished", async () => {
  const user = userEvent.setup();
  useWorkspace.setState({ engines: { data: [engine({}), engine({ id: "codex", name: "Codex", auth: "logged_out" })], error: null, loading: false } });
  const onClose = vi.fn();
  render(<WelcomeWizard onClose={onClose} />);
  expect(screen.getByText("Ready")).toBeInTheDocument();
  expect(screen.getByText("Sign in needed")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Add project" }));
  expect(onClose).not.toHaveBeenCalled();
  expect(useUi.getState().palette).toBe("add-project");
  await user.click(screen.getByRole("button", { name: "Find conversations" }));
  expect(await screen.findByText("No saved conversations found.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalled();
  expect(useUi.getState().welcomeDone).toBe(true);
  expect(useUi.getState().welcomeStep).toBeNull();
});
