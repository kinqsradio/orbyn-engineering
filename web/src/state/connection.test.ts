import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectionKind, markReachable, markUnreachable, useConnection, watchConnection } from "./connection";

beforeEach(() => useConnection.setState({ offline: false, serviceDown: false }));
afterEach(() => vi.useRealTimers());

it("names offline before anything else, and only blames the service while the network is up", () => {
  markUnreachable();
  expect(connectionKind(useConnection.getState())).toBe("service-down");
  markReachable();
  expect(connectionKind(useConnection.getState())).toBeNull();
  useConnection.getState().setOffline(true);
  markUnreachable();
  expect(connectionKind(useConnection.getState())).toBe("offline");
  expect(useConnection.getState().serviceDown).toBe(false);
});

it("follows the browser's network events", () => {
  const stop = watchConnection(() => Promise.resolve());
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  window.dispatchEvent(new Event("offline"));
  expect(useConnection.getState().offline).toBe(true);
  online.mockReturnValue(true);
  window.dispatchEvent(new Event("online"));
  expect(useConnection.getState().offline).toBe(false);
  online.mockRestore();
  stop();
});

it("gives up on a probe that never answers, then asks again", async () => {
  vi.useFakeTimers();
  const probe = vi.fn(() => new Promise<never>(() => undefined));
  const stop = watchConnection(probe);
  markUnreachable();
  await vi.advanceTimersByTimeAsync(3000);
  expect(probe).toHaveBeenCalledTimes(1);
  expect((probe.mock.calls[0] as unknown as [AbortSignal])[0].aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect((probe.mock.calls[0] as unknown as [AbortSignal])[0].aborted).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(useConnection.getState().serviceDown).toBe(true);
  stop();
});

it("asks the service every few seconds while it is down, and clears when it answers", async () => {
  vi.useFakeTimers();
  const probe = vi.fn().mockResolvedValue({});
  const stop = watchConnection(probe);
  markUnreachable();
  await vi.advanceTimersByTimeAsync(3000);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(useConnection.getState().serviceDown).toBe(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(probe).toHaveBeenCalledTimes(1);
  stop();
});
