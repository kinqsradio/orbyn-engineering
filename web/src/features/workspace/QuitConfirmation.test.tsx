import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useWorkspace } from "../../state/workspace";
import type { Thread } from "../../api/types";
import { QuitConfirmation } from "./QuitConfirmation";

let mode = "hold";
vi.mock("../../api/client", async (original) => {
  const actual = await original<typeof import("../../api/client")>();
  return {
    ...actual,
    request: vi.fn(async () => [{ key: "quit_confirmation", value: mode }]),
    api: { ...actual.api, info: vi.fn(async () => ({ platform: "macos" })), shellAction: vi.fn(async () => undefined) },
  };
});
vi.mock("../../api/shell", () => ({ inDesktopApp: () => true, readShellStatus: async () => undefined }));

beforeEach(() => {
  useWorkspace.setState({
    threads: { a: { id: "a", active_run: { state: "running" } }, b: { id: "b", active_run: { state: "running" } } } as unknown as Record<string, Thread>,
  });
});

const press = async () => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
    fireEvent.keyDown(window, { key: "q", metaKey: true });
  });
};

it.each([
  ["hold", "Hold to quit", "2 agents are working. Keep holding ⌘Q."],
  ["double_press", "Press ⌘Q again to quit", "2 agents are working and will stop."],
])("says what ⌘Q does in %s mode, with the real agent count", async (value, title, body) => {
  mode = value;
  render(<QuitConfirmation />);
  await press();
  expect(await screen.findByText(title)).toBeInTheDocument();
  expect(screen.getByText(body)).toBeInTheDocument();
});

it("shows no dialog when quitting is at once", async () => {
  mode = "direct";
  render(<QuitConfirmation />);
  await press();
  expect(screen.queryByRole("status")).toBeNull();
});
