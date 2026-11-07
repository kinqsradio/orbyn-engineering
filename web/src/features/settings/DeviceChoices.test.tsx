import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { useUi } from "../../state/ui";
import { ChatSection, GeneralSection } from "./PreferenceSections";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";
vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn(), api: { ...(await original<{ api: object }>()).api, browse: vi.fn().mockResolvedValue({ path: "/home", parent: null, entries: [{ name: "Code", path: "/home/Code", is_git: false }] }) } }));

it("sets what Enter does while a turn runs from a select", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockResolvedValue(scopedFixture([]));
  render(<ChatSection />);
  const select = await screen.findByRole("combobox", { name: "While a turn runs, Enter" });
  expect(screen.getByText("Steer sends it into the turn that is running.")).toBeVisible();
  await user.selectOptions(select, "Steers the running turn");
  expect(useUi.getState().followUpBehavior).toBe("steer");
});

it("reads and writes Show answers at the device scope with no inheritance icon", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockReset();
  vi.mocked(request).mockResolvedValue(scopedFixture([
    { key: "response_streaming_mode", value: "paragraph", default: "paragraph", source: "default", project_scoped: false },
  ]));
  render(<ChatSection />);
  await user.selectOptions(await screen.findByRole("combobox", { name: "Show answers" }), "When the turn ends");
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({ scope: {}, edits: { response_streaming_mode: { op: "set", value: "turn" } } })));
  expect(screen.queryByRole("button", { name: /Set for this project|From this device/ })).toBeNull();
});

it("picks the base directory with the folder browser", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockReset();
  vi.mocked(request).mockResolvedValue(scopedFixture([
    { key: "add_project_base_directory", value: "", default: "", source: "default", project_scoped: false },
  ]));
  render(<GeneralSection />);
  await user.click(await screen.findByRole("button", { name: "Choose…" }));
  const use = await screen.findByRole("button", { name: "Use this folder" });
  await waitFor(() => expect(use).toBeEnabled());
  await user.click(use);
  await waitFor(() => expect(request).toHaveBeenCalledWith("PUT", "/api/settings/preferences", expect.objectContaining({ edits: { add_project_base_directory: { op: "set", value: "/home" } } })));
});
