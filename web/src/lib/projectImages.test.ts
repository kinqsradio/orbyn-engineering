import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectIconImage } from "../generated/ProjectIconImage";
const mock = vi.hoisted(() => ({ request: vi.fn(), origin: "http://127.0.0.1:1234" }));
vi.mock("../api/client", () => ({ request: mock.request }));
vi.mock("../api/origin", () => ({ serviceUrl: (path: string) => `${mock.origin}${path}` }));
const project = { id: "one", path: "/selected/one" };
const payload = (id = project.id, path = project.path, data = "aGVsbG8="): ProjectIconImage => ({
  project_id: id, project_path: path,
  image: { source: "automatic", relative_path: "favicon.png", revision: "rev", media_type: "png", data_base64: data },
});
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
let cache: typeof import("./projectImages");
let cleanup: (() => void)[];
beforeEach(async () => {
  vi.resetModules(); mock.request.mockReset(); mock.origin = "http://127.0.0.1:1234";
  vi.useFakeTimers(); cleanup = [];
  cache = await import("./projectImages");
});
afterEach(() => { cleanup.forEach((unsubscribe) => unsubscribe()); vi.useRealTimers(); });
function subscribe(identity = project, listener = vi.fn()) {
  const key = cache.projectImageKey(identity);
  const unsubscribe = cache.subscribeProjectImage(key, identity, listener);
  cleanup.push(unsubscribe);
  return { key, unsubscribe, listener };
}
describe("shared local project images", () => {
  it("deduplicates subscribers without cancelling another badge when one unmounts", async () => {
    let resolve!: (value: ProjectIconImage) => void;
    mock.request.mockReturnValue(new Promise<ProjectIconImage>((done) => { resolve = done; }));
    const first = subscribe(); const second = subscribe();
    expect(mock.request).toHaveBeenCalledTimes(1);
    first.unsubscribe();
    expect((mock.request.mock.calls[0]?.[3] as AbortSignal).aborted).toBe(false);
    resolve(payload()); await flush();
    expect(cache.readProjectImage(second.key)).toBe("data:image/png;base64,aGVsbG8=");
    expect(second.listener).toHaveBeenCalled();
  });
  it("separates paths and service origins and rejects mismatched replies", async () => {
    mock.request.mockResolvedValue(payload());
    const first = subscribe(); await flush();
    const moved = subscribe({ ...project, path: "/new/root" }); await flush();
    expect(cache.readProjectImage(moved.key)).toBeNull();
    mock.origin = "http://127.0.0.1:5678";
    const restarted = subscribe(); await flush();
    expect(restarted.key).not.toBe(first.key);
    expect(mock.request).toHaveBeenCalledTimes(3);
  });
  it("fences late reads after refresh", async () => {
    const resolve: ((value: ProjectIconImage) => void)[] = [];
    mock.request.mockImplementation(() => new Promise<ProjectIconImage>((done) => resolve.push(done)));
    const entry = subscribe(); cache.invalidateProjectImages();
    expect((mock.request.mock.calls[0]?.[3] as AbortSignal).aborted).toBe(true);
    resolve[1]!(payload(project.id, project.path, "bmV3")); await flush();
    resolve[0]!(payload()); await flush();
    expect(cache.readProjectImage(entry.key)).toBe("data:image/png;base64,bmV3");
  });
  it("rechecks hits after ten minutes and decode failures after one minute", async () => {
    mock.request.mockResolvedValue(payload());
    const entry = subscribe(); await flush();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(mock.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.request).toHaveBeenCalledTimes(2);
    cache.rejectProjectImage(entry.key, cache.readProjectImage(entry.key)!);
    expect(cache.readProjectImage(entry.key)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.request).toHaveBeenCalledTimes(3);
  });
  it("bounds entries and input bytes and cannot form arbitrary data URL types", async () => {
    mock.request.mockImplementation(async (_method: string, url: string) => {
      const id = url.split("/")[3]!; return payload(id, `/root/${id}`);
    });
    const entries = [];
    for (let i = 0; i < 65; i += 1) { entries.push(subscribe({ id: String(i), path: `/root/${i}` })); await flush(); }
    expect(cache.readProjectImage(entries[0]!.key)).toBeNull();
    expect(cache.readProjectImage(entries[64]!.key)).not.toBeNull();
    mock.request.mockResolvedValue({ ...payload(), image: { ...payload().image!, media_type: "text/html" } });
    const invalid = subscribe(); await flush(); expect(cache.readProjectImage(invalid.key)).toBeNull();
    mock.request.mockResolvedValue(payload(project.id, project.path, "A".repeat(1_398_108)));
    cache.invalidateProjectImages(); await flush(); expect(cache.readProjectImage(invalid.key)).toBeNull();
  });
  it("keeps encoded image bytes within the shared memory budget", async () => {
    const large = "A".repeat(1_398_102) + "==";
    mock.request.mockImplementation(async (_method: string, url: string) => {
      const id = url.split("/")[3]!; return payload(id, `/root/${id}`, large);
    });
    const keys: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      keys.push(subscribe({ id: String(i), path: `/root/${i}` }).key); await flush();
    }
    const retained = keys.map((key) => cache.readProjectImage(key));
    expect(retained.reduce((sum, url) => sum + (url?.length ?? 0), 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(retained[0]).toBeNull();
    expect(retained.at(-1)).not.toBeNull();
  });
  it("expires a hung request, retries, and fences its eventual late reply", async () => {
    let late!: (value: ProjectIconImage) => void;
    mock.request.mockReturnValueOnce(new Promise<ProjectIconImage>((done) => { late = done; }))
      .mockResolvedValue(payload(project.id, project.path, "bmV3"));
    const entry = subscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((mock.request.mock.calls[0]?.[3] as AbortSignal).aborted).toBe(true);
    expect(cache.readProjectImage(entry.key)).toBeNull();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(cache.readProjectImage(entry.key)).toBe("data:image/png;base64,bmV3");
    late(payload()); await flush();
    expect(cache.readProjectImage(entry.key)).toBe("data:image/png;base64,bmV3");
  });
  it("retries optional request failures and null images after one minute", async () => {
    mock.request.mockRejectedValue(new Error("offline"));
    const entry = subscribe(); await flush(); expect(cache.readProjectImage(entry.key)).toBeNull();
    mock.request.mockResolvedValue({ ...payload(), image: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.request).toHaveBeenCalledTimes(2);
    mock.request.mockResolvedValue(payload()); await vi.advanceTimersByTimeAsync(60_000);
    expect(cache.readProjectImage(entry.key)).not.toBeNull();
  });
});
