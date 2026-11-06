import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { PreviewTab } from "../../api/types";
import { BrowserRecording } from "./BrowserRecording";
import { PreviewRecordings } from "./previewRecording";

function tab(change: Partial<PreviewTab> = {}): PreviewTab {
  return {
    id: "first", thread_id: "thread", url: "http://fixture/", title: "Synthetic page",
    control: "none", recording: false, viewers: 0, width: 400, height: 200,
    can_go_back: false, can_go_forward: false, zoom: 1, appearance: "system",
    mobile: false, private: false, profile: null, opened_by: "person", crashed: false,
    ...change,
  };
}

it("starts with click and navigation key overlays off", async () => {
  const calls: string[] = [];
  const actions = new PreviewRecordings(async <T,>(_method: string, path: string) => {
    calls.push(path);
    return undefined as T;
  });
  render(<BrowserRecording tab={tab()} endpoint="/first/recording" actions={actions} refresh={vi.fn(async () => {})} />);
  expect(screen.getByRole("combobox", { name: "Recording maximum FPS" })).toHaveValue("5");
  expect(screen.getByRole("checkbox", { name: "Show clicks" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Show navigation keys" })).not.toBeChecked();
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: "Start recording" }));
  expect(calls).toEqual(["/first/recording?fps=5&show_mouse_presses=false&show_key_presses=false"]);
});

it("reports the server's successful count and retained quota error on finish", async () => {
  const receipt = { path: "owned/synthetic", frames: 3, error: "Recording reached its byte limit." };
  const actions = new PreviewRecordings(async <T,>() => receipt as T);
  render(<BrowserRecording tab={tab({ recording_error: receipt.error })} endpoint="/first/recording" actions={actions} refresh={vi.fn(async () => {})} />);
  expect(screen.queryByRole("combobox", { name: "Recording maximum FPS" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Finish recording" }));
  expect(await screen.findByText("Saved 3 frames.")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Recording folder" })).toHaveValue(receipt.path);
  expect(screen.getByRole("alert")).toHaveTextContent(receipt.error);
});

it("a late stop receipt never appears beneath a replacement tab", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { finish = resolve; });
  const actions = new PreviewRecordings(async <T,>() => await pending as T);
  const refresh = vi.fn(async () => {});
  const view = render(<BrowserRecording key="first" tab={tab({ recording: true })} endpoint="/first/recording" actions={actions} refresh={refresh} />);
  await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  expect(screen.getByRole("button", { name: "Stop recording" })).toBeDisabled();
  view.rerender(<BrowserRecording key="second" tab={tab({ id: "second" })} endpoint="/second/recording" actions={actions} refresh={refresh} />);
  await act(async () => { finish({ path: "owned/first", frames: 8 }); await pending; });
  expect(screen.queryByText("Saved 8 frames.")).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
  view.rerender(<BrowserRecording key="first" tab={tab()} endpoint="/first/recording" actions={actions} refresh={refresh} />);
  expect(screen.getByText("Saved 8 frames.")).toBeVisible();
});
