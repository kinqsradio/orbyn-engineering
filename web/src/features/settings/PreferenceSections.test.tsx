import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { ChatSection } from "./PreferenceSections";
vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
it("offers the reference usage-limit defaults with their existing preference keys", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockResolvedValue([
    { key: "auto_resume_limited_threads", value: false, default: false, source: "default", project_scoped: false },
    { key: "snooze_limited_threads", value: false, default: false, source: "default", project_scoped: false },
  ]);
  render(<ChatSection />);
  expect(await screen.findByRole("switch", { name: "Snooze until limits reset" })).not.toBeChecked();
  await user.click(screen.getByRole("switch", { name: "Resume after usage limits" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/preferences", { values: { auto_resume_limited_threads: true } }));
});
