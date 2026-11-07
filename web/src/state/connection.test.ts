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
  window.dispatchEvent(new Event("offline"));
  expect(useConnection.getState().offline).toBe(navigator.onLine === false);
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
