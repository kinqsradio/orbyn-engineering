import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectIconResource } from "../generated/ProjectIconResource";
const mock = vi.hoisted(() => ({ request: vi.fn(), preview: vi.fn(), read: vi.fn(), store: vi.fn(),
  remove: vi.fn(), purge: vi.fn(), clear: vi.fn(), origin: "http://127.0.0.1:1234" }));
vi.mock("../api/client", () => ({ request: mock.request }));
vi.mock("../api/origin", () => ({ serviceUrl: (path: string) => `${mock.origin}${path}` }));
vi.mock("./projectImagePreview", () => ({ projectImagePreview: mock.preview,
  PROJECT_IMAGE_MIME: { png: "image/png", svg: "image/svg+xml" }, MissingProjectImage: class extends Error {} }));
vi.mock("./projectImagePersistence", () => ({ readStoredProjectImage: mock.read, storeProjectImage: mock.store,
  deleteStoredProjectImage: mock.remove, purgeStoredProjectImages: mock.purge, clearStoredProjectImages: mock.clear }));
const project = { id: "one", path: "/selected/one" };
const A = "a".repeat(64), B = "b".repeat(64);
const DATA_A = "data:image/png;base64,aGVsbG8=", DATA_B = "data:image/png;base64,bmV3";
const payload = (id = project.id, path = project.path, revision = A): ProjectIconResource => ({
  project_id: id, project_path: path, favicon_path: null,
  image: { source: "automatic", relative_path: "favicon.png", revision, media_type: "png", size: 5 },
});
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
let cache: typeof import("./projectImages");
let cleanup: (() => void)[];
beforeEach(async () => {
  vi.resetModules();
  for (const fn of [mock.request, mock.preview, mock.read, mock.store, mock.remove, mock.purge, mock.clear]) fn.mockReset();
  mock.origin = "http://127.0.0.1:1234";
  mock.read.mockResolvedValue(null); mock.store.mockResolvedValue(true); mock.remove.mockResolvedValue(true);
  mock.purge.mockResolvedValue(true); mock.clear.mockResolvedValue(true);
  mock.preview.mockImplementation(async (_url: string, _type: string, _size: number, revision: string) => revision === B ? DATA_B : DATA_A);
  vi.useFakeTimers(); cleanup = [];
  cache = await import("./projectImages");
});
afterEach(() => { cleanup.forEach((unsubscribe) => unsubscribe()); vi.useRealTimers(); });
function subscribe(identity: { id: string; path: string; favicon_path?: string | null } = project, listener = vi.fn()) {
  const key = cache.projectImageKey(identity);
  const unsubscribe = cache.subscribeProjectImage(key, identity, listener);
  cleanup.push(unsubscribe);
  return { key, unsubscribe, listener };
}
function stored(revision = A, data = DATA_A) {
  return { key: cache.projectImagePersistentKey(project), project_id: project.id, revision, data_url: data, used_at: 1 };
}
describe("shared local project images", () => {
  it("deduplicates subscribers without cancelling another badge when one unmounts", async () => {
    let resolve!: (value: ProjectIconResource) => void;
    mock.request.mockReturnValue(new Promise<ProjectIconResource>((done) => { resolve = done; }));
    const first = subscribe(); const second = subscribe();
    expect(mock.request).toHaveBeenCalledTimes(1); first.unsubscribe();
    expect((mock.request.mock.calls[0]?.[3] as AbortSignal).aborted).toBe(false);
    resolve(payload()); await flush();
    expect(cache.readProjectImage(second.key)).toBe(DATA_A);
    expect(second.listener).toHaveBeenCalled();
  });
  it("separates paths, saved hints and live service origins and rejects mismatched replies", async () => {
    mock.request.mockResolvedValue(payload());
    const first = subscribe(); await flush();
    const moved = subscribe({ ...project, path: "/new/root" }); await flush();
    expect(cache.readProjectImage(moved.key)).toBeNull();
    const chosen = subscribe({ ...project, favicon_path: "new.png" }); await flush();
    expect(cache.readProjectImage(chosen.key)).toBeNull();
    mock.origin = "http://127.0.0.1:5678";
    const restarted = subscribe(); await flush();
    expect(restarted.key).not.toBe(first.key); expect(mock.request).toHaveBeenCalledTimes(4);
  });
  it("fences late resource reads after refresh", async () => {
    const resolve: ((value: ProjectIconResource) => void)[] = [];
    mock.request.mockImplementation(() => new Promise<ProjectIconResource>((done) => resolve.push(done)));
    const entry = subscribe(); cache.invalidateProjectImages();
    expect((mock.request.mock.calls[0]?.[3] as AbortSignal).aborted).toBe(true);
    resolve[1]!(payload(project.id, project.path, B)); await flush();
    resolve[0]!(payload()); await flush();
    expect(cache.readProjectImage(entry.key)).toBe(DATA_B);
  });
  it("rechecks hits after ten minutes and decode failures after one minute", async () => {
    mock.request.mockResolvedValue(payload());
    const entry = subscribe(); await flush();
    await vi.advanceTimersByTimeAsync(9 * 60_000); expect(mock.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(mock.request).toHaveBeenCalledTimes(2);
    cache.rejectProjectImage(entry.key, cache.readProjectImage(entry.key)!);
    expect(cache.readProjectImage(entry.key)).toBeNull(); expect(mock.remove).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); expect(mock.request).toHaveBeenCalledTimes(3);
  });
  it("bounds 128 observations and cannot form arbitrary image URL types or unbounded resources", async () => {
    mock.request.mockImplementation(async (_method: string, url: string) => {
      const id = url.split("/")[3]!; return payload(id, `/root/${id}`);
    });
    const entries = [];
    for (let i = 0; i < 129; i += 1) { entries.push(subscribe({ id: String(i), path: `/root/${i}` })); await flush(); }
    expect(cache.readProjectImage(entries[0]!.key)).toBeNull();
    expect(cache.readProjectImage(entries[128]!.key)).not.toBeNull();
    mock.request.mockResolvedValue({ ...payload(), image: { ...payload().image!, media_type: "text/html" } });
    const invalid = subscribe(); await flush(); expect(cache.readProjectImage(invalid.key)).toBeNull();
    mock.request.mockResolvedValue({ ...payload(), image: { ...payload().image!, size: 1024 * 1024 * 1024 + 1 } });
    cache.invalidateProjectImages(project.id); await flush(); expect(cache.readProjectImage(invalid.key)).toBeNull();
  });
  it("expires a hung request and fences its eventual late reply", async () => {
    let late!: (value: ProjectIconResource) => void;
    mock.request.mockReturnValueOnce(new Promise<ProjectIconResource>((done) => { late = done; }))
      .mockResolvedValue(payload(project.id, project.path, B));
    const entry = subscribe(); await vi.advanceTimersByTimeAsync(30_000);
    expect((mock.request.mock.calls[0]?.[3] as AbortSignal).aborted).toBe(true);
    expect(cache.readProjectImage(entry.key)).toBeNull();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mock.request).toHaveBeenCalledTimes(2); expect(cache.readProjectImage(entry.key)).toBe(DATA_B);
    late(payload()); await flush(); expect(cache.readProjectImage(entry.key)).toBe(DATA_B);
  });
  it("restores a persisted preview on read failure and clears it on authoritative missing", async () => {
    mock.read.mockResolvedValue(stored()); mock.request.mockRejectedValue(new Error("offline"));
    const entry = subscribe(); await flush(); expect(cache.readProjectImage(entry.key)).toBe(DATA_A);
    mock.request.mockResolvedValue({ ...payload(), image: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cache.readProjectImage(entry.key)).toBeNull(); expect(mock.remove).toHaveBeenCalledWith(stored().key, project.id);
  });
  it("clears a restored preview when the registered resource is refused", async () => {
    mock.read.mockResolvedValue(stored()); mock.request.mockRejectedValue({ status: 403 });
    const entry = subscribe(); await flush(); expect(cache.readProjectImage(entry.key)).toBeNull();
    expect(mock.remove).toHaveBeenCalledWith(stored().key, project.id);
  });
  it("reuses a persisted matching content revision without fetching image bytes", async () => {
    mock.read.mockResolvedValue(stored()); mock.request.mockResolvedValue(payload());
    const entry = subscribe(); await flush(); expect(cache.readProjectImage(entry.key)).toBe(DATA_A);
    expect(mock.preview).not.toHaveBeenCalled();
  });
  it("keeps the previous preview while a replacement loads and through a transient error", async () => {
    mock.request.mockResolvedValue(payload()); const entry = subscribe(); await flush();
    let finish!: (value: string) => void;
    mock.request.mockResolvedValue(payload(project.id, project.path, B));
    mock.preview.mockReturnValue(new Promise<string>((done) => { finish = done; }));
    cache.invalidateProjectImages(project.id); await flush(); expect(cache.readProjectImage(entry.key)).toBe(DATA_A);
    finish(DATA_B); await flush(); expect(cache.readProjectImage(entry.key)).toBe(DATA_B);
    mock.request.mockRejectedValue(new Error("offline")); cache.invalidateProjectImages(project.id); await flush();
    expect(cache.readProjectImage(entry.key)).toBe(DATA_B);
  });
  it("fences a late decoded preview when the cache is cleared", async () => {
    let finish!: (value: string) => void;
    mock.request.mockResolvedValueOnce(payload()).mockResolvedValue(payload(project.id, project.path, B));
    mock.preview.mockReturnValueOnce(new Promise<string>((done) => { finish = done; }))
      .mockResolvedValue(DATA_B);
    const entry = subscribe(); await flush();
    await cache.clearProjectImageCache(); await flush();
    finish(DATA_A); await flush(); expect(cache.readProjectImage(entry.key)).toBe(DATA_B);
    expect(mock.store.mock.calls.some(([item]) => item.revision === A)).toBe(false);
  });
  it("uses a versioned fixed service URL for images that cannot be cached as a small preview", async () => {
    mock.preview.mockResolvedValue(null); mock.request.mockResolvedValue({ ...payload(), image: { ...payload().image!, size: 5 * 1024 * 1024 } });
    const entry = subscribe(); await flush();
    expect(cache.readProjectImage(entry.key)).toBe(`${mock.origin}/api/projects/one/icon/raw?v=${A}`);
    expect(mock.store).not.toHaveBeenCalled();
  });
  it("never persists an authenticated image URL or a volatile owned service port", async () => {
    sessionStorage.setItem("orbyn.token", "fixture-session");
    const persistent = cache.projectImagePersistentKey(project);
    mock.origin = "http://127.0.0.1:5678";
    expect(cache.projectImagePersistentKey(project)).toBe(persistent);
    mock.request.mockResolvedValue(payload()); subscribe(); await flush();
    expect(JSON.stringify(mock.store.mock.calls)).not.toContain("fixture-session");
    expect(JSON.stringify(mock.store.mock.calls)).not.toContain("127.0.0.1:5678");
    expect(mock.store.mock.calls[0]?.[0].data_url).toBe(DATA_A);
  });
});
