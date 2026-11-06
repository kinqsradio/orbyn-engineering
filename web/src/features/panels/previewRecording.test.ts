import { expect, it, vi } from "vitest";
import { ApiFailure } from "../../api/client";
import { PreviewRecordings } from "./previewRecording";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("keeps overlays off by default and sends explicitly selected mouse and qualified key options", async () => {
  const calls: { method: string; path: string }[] = [];
  const actions = new PreviewRecordings(async <T>(method: string, path: string) => {
    calls.push({ method, path });
    return undefined as T;
  });
  actions.focus("/first/recording");
  const refresh = vi.fn(async () => {});
  await actions.run("/first/recording", { fps: 5, showMousePresses: false }, refresh);
  await actions.run("/first/recording", { fps: 10, showMousePresses: true, showKeyPresses: true }, refresh);
  expect(calls).toEqual([
    { method: "POST", path: "/first/recording?fps=5&show_mouse_presses=false&show_key_presses=false" },
    { method: "POST", path: "/first/recording?fps=10&show_mouse_presses=true&show_key_presses=true" },
  ]);
});

it("deduplicates in-flight writes and retains a stop receipt under its invocation tab", async () => {
  const pending = deferred<unknown>();
  const transport = vi.fn(async () => await pending.promise);
  const actions = new PreviewRecordings(async <T>() => await transport() as T);
  const leaveFirst = actions.focus("/first/recording");
  const refresh = vi.fn(async () => {});
  const stop = actions.run("/first/recording", null, refresh);
  await actions.run("/first/recording", null, refresh);
  expect(transport).toHaveBeenCalledTimes(1);
  actions.focus("/second/recording");
  leaveFirst(); // An older view's cleanup cannot clear the new view's ownership.
  const receipt = { path: "owned/synthetic", frames: 7, error: "Recording reached its frame limit." };
  pending.resolve(receipt);
  await stop;
  expect(refresh).not.toHaveBeenCalled();
  expect(actions.state("/first/recording").result).toEqual(receipt);
  expect(actions.state("/second/recording")).toEqual({ pending: false, result: null, error: null, active: null });
});

it("keeps confirmed frame accounting even if refreshing the current tab fails", async () => {
  const receipt = { path: "owned/synthetic", frames: 2 };
  const actions = new PreviewRecordings(async <T>() => receipt as T);
  actions.focus("/first/recording");
  await actions.run("/first/recording", null, async () => { throw new ApiFailure("offline", "Try again.", 503); });
  expect(actions.state("/first/recording")).toEqual({
    pending: false, result: receipt, error: "Couldn't refresh the page status. Try again.", active: false,
  });
});

it("an unmounted view cannot refresh another thread and write failures remain retryable", async () => {
  const pending = deferred<unknown>();
  const actions = new PreviewRecordings(async <T>() => await pending.promise as T);
  const leave = actions.focus("/first/recording");
  const refresh = vi.fn(async () => {});
  const start = actions.run("/first/recording", { fps: 5, showMousePresses: false }, refresh);
  leave();
  pending.reject(new ApiFailure("disk", "Couldn't write recording.", 500));
  await start;
  expect(refresh).not.toHaveBeenCalled();
  expect(actions.state("/first/recording")).toEqual({ pending: false, result: null, error: "Couldn't write recording.", active: null });
});

it("stale polling cannot reverse a committed start or stop after a read failure", async () => {
  const receipt = { path: "owned/synthetic", frames: 2 };
  const transport = vi.fn(async () => receipt);
  const actions = new PreviewRecordings(async <T>() => await transport() as T);
  actions.focus("/first/recording");
  const offline = async () => { throw new ApiFailure("offline", "Try again.", 503); };
  await actions.run("/first/recording", { fps: 5, showMousePresses: false }, offline);
  actions.observe("/first/recording", { recording: false });
  expect(actions.state("/first/recording").active).toBe(true);
  await actions.run("/first/recording", null, offline);
  actions.observe("/first/recording", { recording: true });
  expect(actions.state("/first/recording").active).toBe(false);
  await actions.run("/first/recording", null, offline);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(actions.state("/first/recording").result).toEqual(receipt);
});
