import { afterEach, expect, it, vi } from "vitest";
import { ApiFailure, api } from "../../api/client";
import type { EngineModels } from "../../api/types";
import { useModelStore } from "./modelStore";

afterEach(() => vi.restoreAllMocks());

const catalog = (engine: string, label: string, error: string | null = null): EngineModels => ({
  engine, source: "engine", checked_at: "2026-11-05T00:00:00Z", error,
  models: [{ id: label, label, description: null, custom: false, is_default: true, options: [] }],
});

it("forces discovery, retains a list after transport failure, and recovers", async () => {
  const engine = "refresh-recovery";
  const first = catalog(engine, "first");
  const recovered = catalog(engine, "recovered");
  const read = vi.spyOn(api, "models").mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new ApiFailure("unavailable", "Service unavailable", 503))
    .mockResolvedValueOnce(recovered);
  await useModelStore.getState().load(engine);
  await useModelStore.getState().reload(engine);
  expect(read).toHaveBeenLastCalledWith(engine, undefined, true);
  expect(useModelStore.getState().byEngine[engine]).toEqual(first);
  expect(useModelStore.getState().errors[engine]).toContain("Service unavailable");
  expect(useModelStore.getState().loading[engine]).toBe(false);
  await useModelStore.getState().reload(engine);
  expect(useModelStore.getState().byEngine[engine]).toEqual(recovered);
  expect(useModelStore.getState().errors[engine]).toBeNull();
});

it("shows a service discovery failure while keeping its last good catalog", async () => {
  const engine = "service-discovery-failure";
  const kept = catalog(engine, "kept", "Engine did not respond");
  vi.spyOn(api, "models").mockResolvedValueOnce(kept).mockResolvedValueOnce(catalog(engine, "new"));
  await useModelStore.getState().load(engine);
  expect(useModelStore.getState().errors[engine]).toBe("Engine did not respond");
  expect(useModelStore.getState().byEngine[engine]).toEqual(kept);
  await useModelStore.getState().load(engine);
  expect(useModelStore.getState().byEngine[engine]?.models[0]?.id).toBe("new");
});

it("ignores an older reply or failure after a newer forced refresh", async () => {
  for (const fail of [false, true]) {
    const engine = `racing-discovery-${fail}`;
    let resolve!: (value: EngineModels) => void;
    let reject!: (failure: Error) => void;
    const older = new Promise<EngineModels>((yes, no) => { resolve = yes; reject = no; });
    vi.spyOn(api, "models").mockReturnValueOnce(older).mockResolvedValueOnce(catalog(engine, "new"));
    const loading = useModelStore.getState().load(engine);
    await useModelStore.getState().reload(engine);
    if (fail) reject(new Error("Late failure"));
    else resolve(catalog(engine, "old"));
    await loading;
    expect(useModelStore.getState().byEngine[engine]?.models[0]?.id).toBe("new");
    expect(useModelStore.getState().errors[engine]).toBeNull();
    expect(useModelStore.getState().loading[engine]).toBe(false);
  }
});
