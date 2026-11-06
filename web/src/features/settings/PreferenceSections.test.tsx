import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { useUi } from "../../state/ui";
import { ChatSection, DiffsSection } from "./PreferenceSections";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";
vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
it("offers the reference usage-limit defaults with their existing preference keys", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockResolvedValue(scopedFixture([
    { key: "auto_resume_limited_threads", value: false, default: false, source: "default", project_scoped: false },
    { key: "snooze_limited_threads", value: false, default: false, source: "default", project_scoped: false },
  ]));
  render(<ChatSection />);
  expect(await screen.findByRole("switch", { name: "Snooze until limits reset" })).not.toBeChecked();
  await user.click(screen.getByRole("switch", { name: "Resume after usage limits" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({ scope: {}, edits: { auto_resume_limited_threads: { op: "set", value: true } }, if_match: { auto_resume_limited_threads: expect.any(String) } })));
});

it("turns review guides on and sets the guide model", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockReset();
  vi.mocked(request).mockResolvedValue(scopedFixture([
    { key: "pull_request_merge_method", value: "", default: "", source: "default", project_scoped: true },
    { key: "remove_agent_credits_on_merge", value: false, default: false, source: "default", project_scoped: true },
    { key: "review_guides_enabled", value: false, default: false, source: "default", project_scoped: true },
    { key: "review_guide_instructions", value: "", default: "", source: "default", project_scoped: true },
    { key: "review_guide_model", value: "", default: "", source: "default", project_scoped: true },
  ]));
  render(<DiffsSection />);
  await user.click(await screen.findByRole("switch", { name: "Review guides" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({ edits: { review_guides_enabled: { op: "set", value: true } } })));
  expect(screen.getByLabelText("Guide instructions")).toBeInTheDocument();
  await user.type(screen.getByLabelText("Guide model"), "big-model");
  await user.tab();
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({ edits: { review_guide_model: { op: "set", value: "big-model" } } })));
});

it("sets the diff view from settings and follows the diff panel's stored layout", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockReset();
  vi.mocked(request).mockResolvedValue(scopedFixture([]));
  useUi.getState().setPrefs({ diffLayout: "stacked" });
  render(<DiffsSection />);
  const group = await screen.findByRole("radiogroup", { name: "Diff view" });
  expect(within(group).getByRole("radio", { name: "Unified" })).toBeChecked();
  await user.click(within(group).getByRole("radio", { name: "Split" }));
  expect(useUi.getState().diffLayout).toBe("split");
  act(() => useUi.getState().setPrefs({ diffLayout: "stacked" }));
  expect(within(group).getByRole("radio", { name: "Unified" })).toBeChecked();
});
