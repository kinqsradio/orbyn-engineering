import { afterEach, describe, expect, it, vi } from "vitest";
import { pullsApi } from "./pulls";

afterEach(() => vi.unstubAllGlobals());

describe("pullsApi.details", () => {
  it("posts the listed rows and whether the refresh was the person's own", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ details: [], paused: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { pulls: [{ project_id: "p", number: 3, updated_at: "t" }], fresh: true };
    await expect(pullsApi.details(body)).resolves.toEqual({ details: [], paused: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/pulls/details");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });
});
