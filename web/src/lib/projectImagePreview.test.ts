import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingProjectImage, projectImagePreview } from "./projectImagePreview";
const revision = "a".repeat(64);
const signal = () => new AbortController().signal;
const fetcher = vi.fn();
function response(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { etag: `"${revision}"`, ...headers } });
}
beforeEach(() => { sessionStorage.setItem("orbyn.token", "fixture"); vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); });
afterEach(() => { sessionStorage.removeItem("orbyn.token"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("bounded project image previews", () => {
  it("does not fetch a source above four MiB", async () => {
    expect(await projectImagePreview("/icon", "png", 4194305, revision, signal())).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("authenticates the fixed source and retains a small data image", async () => {
    fetcher.mockResolvedValue(response(new Uint8Array([1, 2, 3])));
    expect(await projectImagePreview("/icon", "png", 3, revision, signal())).toBe("data:image/png;base64,AQID");
    expect(fetcher).toHaveBeenCalledWith("/icon", expect.objectContaining({ headers: { Authorization: "Bearer fixture" }, credentials: "same-origin" }));
  });
  it("distinguishes missing or refused images from transient reads", async () => {
    for (const status of [403, 404]) {
      fetcher.mockResolvedValue(new Response(null, { status }));
      await expect(projectImagePreview("/icon", "png", 1, revision, signal())).rejects.toBeInstanceOf(MissingProjectImage);
    }
    fetcher.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(projectImagePreview("/icon", "png", 1, revision, signal())).rejects.toThrow("read failed");
  });
  it("cancels mismatched revisions before consuming the body", async () => {
    const cancel = vi.fn();
    fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { etag: '"stale"' } }));
    await expect(projectImagePreview("/icon", "png", 1, revision, signal())).rejects.toThrow("changed");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("bounds both declared and streamed lengths and cancels oversized readers", async () => {
    for (const declared of [false, true]) {
      const cancel = vi.fn();
      fetcher.mockResolvedValue(new Response(new ReadableStream({
        start(controller) { if (!declared) controller.enqueue(new Uint8Array(4194305)); }, cancel,
      }), { headers: { etag: `"${revision}"`, ...(declared ? { "content-length": "4194305" } : {}) } }));
      expect(await projectImagePreview("/icon", "png", 1, revision, signal())).toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it("leaves large SVGs in image mode without bitmap decoding", async () => {
    const bitmap = vi.fn(); vi.stubGlobal("createImageBitmap", bitmap);
    fetcher.mockResolvedValue(response(new Uint8Array(30000)));
    expect(await projectImagePreview("/icon", "svg", 30000, revision, signal())).toBeNull();
    expect(bitmap).not.toHaveBeenCalled();
  });
  it("tries 96 then 48 WebP previews and closes its bitmap", async () => {
    const close = vi.fn(), draw = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 200, height: 100, close }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValueOnce(`data:image/webp;base64,${"A".repeat(40000)}`)
      .mockReturnValueOnce("data:image/webp;base64,AQID");
    fetcher.mockResolvedValue(response(new Uint8Array(30000)));
    expect(await projectImagePreview("/icon", "png", 30000, revision, signal())).toBe("data:image/webp;base64,AQID");
    expect(draw.mock.calls.map((args) => args.slice(1))).toEqual([[0, 0, 96, 48], [0, 0, 48, 24]]);
    expect(encode.mock.calls).toEqual([["image/webp", 0.85], ["image/webp", 0.85]]);
    expect(close).toHaveBeenCalledOnce();
  });
  it("closes a decoded bitmap after cancellation or encoder failure", async () => {
    for (const abort of [false, true]) {
      const controller = new AbortController(), close = vi.fn();
      vi.stubGlobal("createImageBitmap", vi.fn().mockImplementation(async () => {
        if (abort) controller.abort();
        return { width: 100, height: 100, close };
      }));
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => { throw new Error("unavailable"); });
      fetcher.mockResolvedValue(response(new Uint8Array(30000)));
      expect(await projectImagePreview("/icon", "png", 30000, revision, controller.signal)).toBeNull();
      expect(close).toHaveBeenCalledOnce();
    }
  });
});
