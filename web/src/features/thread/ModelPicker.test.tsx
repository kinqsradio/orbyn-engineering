import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { EngineModels, EngineStatus } from "../../api/types";
import { ModelPickerTrigger } from "./ModelPicker";
import { useModelStore } from "./modelStore";

vi.mock("../../api/client", async (original) => {
  const actual = await original<typeof import("../../api/client")>();
  return { ...actual, api: { ...actual.api, models: vi.fn() } };
});
const engines = [{ id: "codex", name: "Codex", installed: true, capabilities: { managed: true } }] as EngineStatus[];
const catalog: EngineModels = { engine: "codex", source: "engine", checked_at: "fixture", error: null, fallback: false,
  models: [{ id: "small", label: "Small model", description: null, is_default: true, custom: false, options: [] }],
  options: [], agents: [], output_styles: [] };
beforeEach(() => {
  vi.mocked(api.models).mockResolvedValue(catalog);
  useModelStore.setState({ byEngine: { codex: catalog }, loading: {}, errors: {} });
});

it("keeps the actual model picker inside its owning settings dialog and restores focus after choosing", async () => {
  const picked = vi.fn(); const user = userEvent.setup();
  render(<dialog open aria-label="Settings"><ModelPickerTrigger engines={engines}
    selected={{ engine: "codex", model: "small" }} onPick={picked} /></dialog>);
  const settings = screen.getByRole("dialog", { name: "Settings" });
  const trigger = within(settings).getByRole("button", { name: "Small model" });
  await user.click(trigger);
  const picker = await within(settings).findByRole("dialog", { name: "Choose a model" });
  expect(picker.parentElement).toBe(settings);
  await user.click(within(picker).getByRole("option", { name: /Small model/ }));
  expect(picked).toHaveBeenCalledWith({ engine: "codex", model: "small" });
  expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("retains the body portal for an ordinary composer picker", async () => {
  render(<ModelPickerTrigger engines={engines} selected={{ engine: "codex", model: "small" }} onPick={() => undefined} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Small model" }));
  const picker = await screen.findByRole("dialog", { name: "Choose a model" });
  expect(picker.parentElement).toBe(document.body);
});

it("shows the supplied Mixed or Automatic label without changing the underlying selection", async () => {
  const props = { engines, selected: { engine: "codex", model: "small" }, onPick: vi.fn() };
  const { rerender } = render(<ModelPickerTrigger {...props} triggerLabel="Mixed" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Mixed" })).toBeVisible());
  rerender(<ModelPickerTrigger {...props} triggerLabel="Automatic" />);
  expect(screen.getByRole("button", { name: "Automatic" })).toBeVisible();
  expect(props.onPick).not.toHaveBeenCalled();
});
