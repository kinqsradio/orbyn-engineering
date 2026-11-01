import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { ChatSection } from "./PreferenceSections";
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
