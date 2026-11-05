import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { WritingStyleControl } from "./SourceControlWriting";

it("preserves custom instructions when changing style and templates", async () => {
  const user = userEvent.setup(); const save = vi.fn();
  render(<WritingStyleControl value={{ mode: "repo_conventions", custom_instructions: "Keep issue IDs", follow_templates: true }} save={save} />);
  await user.selectOptions(screen.getByLabelText("Source control writing style"), "custom");
  expect(screen.getByLabelText("Custom source control writing instructions")).toHaveValue("Keep issue IDs");
  await user.clear(screen.getByLabelText("Custom source control writing instructions"));
  await user.type(screen.getByLabelText("Custom source control writing instructions"), "Use short French summaries");
  await user.tab();
  expect(save).toHaveBeenLastCalledWith({ mode: "custom", custom_instructions: "Use short French summaries", follow_templates: true });
  await user.click(screen.getByRole("switch", { name: "Follow change request templates" }));
  expect(save).toHaveBeenLastCalledWith({ mode: "custom", custom_instructions: "Use short French summaries", follow_templates: false });
});

it("represents mixed settings without silently choosing a mode", () => {
  const save = vi.fn(); render(<WritingStyleControl value={{}} mixed save={save} />);
  expect(screen.getByLabelText("Source control writing style")).toHaveValue("mixed");
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "mixed");
  expect(save).not.toHaveBeenCalled();
});
