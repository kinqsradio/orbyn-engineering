import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { FallbackControl } from "./ProjectModelDefaults";

vi.mock("../../state/modelStore", () => ({
  useEngineModels: () => ({ models: [{ id: "sonnet", label: "Sonnet 5.5" }, { id: "opus", label: "Opus 5.5" }] }),
  useModelStore: Object.assign(() => undefined, { getState: () => ({}) }),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspace: (select: (state: unknown) => unknown) => select({ engines: { data: [{ id: "claude", installed: true }] } }),
}));

it("picks a known model from the select", async () => {
  const save = vi.fn();
  render(<FallbackControl value="" save={save} disabled={false} />);
  expect(screen.getByRole("option", { name: "Other…" })).toBeInTheDocument();
  await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Fallback model" }), "opus");
  expect(save).toHaveBeenCalledWith("opus");
});

it("reveals a model id field for Other… and saves it when you leave it", async () => {
  const save = vi.fn();
  const user = userEvent.setup();
  render(<FallbackControl value="sonnet" save={save} disabled={false} />);
  expect(screen.queryByRole("textbox", { name: "Model id" })).toBeNull();
  await user.selectOptions(screen.getByRole("combobox", { name: "Fallback model" }), "__other");
  const field = screen.getByRole("textbox", { name: "Model id" });
  expect(save).not.toHaveBeenCalled();
  await user.type(field, "claude-fable-5-1");
  await user.tab();
  expect(save).toHaveBeenCalledWith("claude-fable-5-1");
});

it("shows a saved id the provider doesn't list under Other…", () => {
  render(<FallbackControl value="claude-fable-5-1" save={() => undefined} disabled={false} />);
  expect(screen.getByRole("combobox", { name: "Fallback model" })).toHaveValue("__other");
  expect(screen.getByRole("textbox", { name: "Model id" })).toHaveValue("claude-fable-5-1");
});
