import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { EngineStatus, PreferenceView } from "../../api/types";
import { useDraftModelDefaults } from "./useDraftModelDefaults";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
const mocked = vi.mocked(request);
const engines = ["codex", "other"].map((id) => ({ id, installed: true, auth: "logged_in", capabilities: { managed: true } })) as EngineStatus[];
const remembered = { engine: "codex", model: "remembered", effort: "high" };
const views = (engine = "", model = "", disabled: string[] = []): PreferenceView[] =>
  Object.entries({ default_engine: engine, default_model: model, disabled_engines: disabled }).map(([key, value]) =>
    ({ key, value, default: "", source: "project", project_scoped: true }));
beforeEach(() => { mocked.mockReset(); });

it("uses the effective checkout's model before the remembered model without carrying foreign effort", async () => {
  mocked.mockResolvedValue(views("other", "project-model") as never);
  const { result } = renderHook(() => useDraftModelDefaults("checkout", engines, remembered));
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.engine?.id).toBe("other");
  expect(result.current.model).toBe("project-model"); expect(result.current.effort).toBeNull();
  expect(mocked.mock.calls[0]?.[1]).toBe("/api/preferences?project_id=checkout");
});

it("keeps Automatic on the existing remembered choice and retains effort only with that model", async () => {
  mocked.mockResolvedValue(views() as never);
  const { result } = renderHook(() => useDraftModelDefaults(null, engines, remembered));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.engine?.id).toBe("codex");
  expect(result.current.model).toBe("remembered"); expect(result.current.effort).toBe("high");
  expect(mocked.mock.calls[0]?.[1]).toBe("/api/preferences");
});

it("does not let a late default replace a person's explicit choice", async () => {
  let resolve!: (value: PreferenceView[]) => void;
  mocked.mockImplementation(() => new Promise((done) => { resolve = done; }) as never);
  const { result } = renderHook(() => useDraftModelDefaults("a", engines, remembered));
  act(() => result.current.choose({ engine: "codex", model: "picked", effort: "low" }));
  await act(async () => resolve(views("other", "late")));
  expect(result.current.model).toBe("picked"); expect(result.current.engine?.id).toBe("codex");
  expect(result.current.effort).toBe("low");
});

it("fences A-to-B-to-A responses and does not carry another project's explicit choice", async () => {
  const pending: ((value: PreferenceView[]) => void)[] = [];
  mocked.mockImplementation(() => new Promise((done) => pending.push(done as never)) as never);
  const { result, rerender } = renderHook(({ id }) => useDraftModelDefaults(id, engines, remembered), { initialProps: { id: "a" } });
  act(() => result.current.choose({ engine: "codex", model: "picked-a", effort: null }));
  rerender({ id: "b" });
  expect(result.current.explicit).toBe(false); expect(result.current.loading).toBe(true);
  rerender({ id: "a" });
  await act(async () => { pending[0]!(views("other", "old-a")); pending[1]!(views("other", "old-b")); });
  expect(result.current.loading).toBe(true);
  await act(async () => pending[2]!(views("other", "new-a")));
  expect(result.current.model).toBe("picked-a");
});

it("does not silently substitute another provider when a configured default is disabled or missing", async () => {
  mocked.mockResolvedValue(views("other", "m", ["other"]) as never);
  const { result } = renderHook(() => useDraftModelDefaults("a", engines, remembered));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.engine).toBeNull(); expect(result.current.error).toMatch(/unavailable/);
  expect(result.current.installed.map((engine) => engine.id)).toEqual(["codex"]);
  act(() => result.current.choose({ engine: "codex", model: "picked", effort: null }));
  expect(result.current.engine?.id).toBe("codex"); expect(result.current.error).toBeNull();
});

it("keeps read errors visible and recovers only through an explicit retry", async () => {
  mocked.mockRejectedValueOnce(new ApiFailure("unavailable", "Settings unavailable", 503));
  const { result } = renderHook(() => useDraftModelDefaults("a", engines, remembered));
  await waitFor(() => expect(result.current.error).toBe("Settings unavailable"));
  mocked.mockResolvedValue(views("codex", "recovered") as never);
  act(() => result.current.reload());
  await waitFor(() => expect(result.current.model).toBe("recovered"));
  expect(result.current.error).toBeNull();
});
