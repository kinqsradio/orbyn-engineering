import { describe, expect, it, vi } from "vitest";
import { ApiFailure, NETWORK_ERROR, request, setUnauthorizedHandler } from "./client";

const respond = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

describe("request", () => {
  it("sends the bearer token when one is held", async () => {
    sessionStorage.setItem("orbyn.token", "tok");
    const fetchMock = respond(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await request("GET", "/api/info");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("maps an ApiError body to its stable code", async () => {
    vi.stubGlobal("fetch", respond(409, { code: "thread_busy", message: "Busy." }));
    await expect(request("POST", "/x")).rejects.toMatchObject({
      code: "thread_busy",
      message: "Busy.",
      status: 409,
    });
  });

  it("falls back to the status for a non-JSON error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    await expect(request("GET", "/x")).rejects.toMatchObject({ code: "http_502" });
  });

  it("reports an unreachable service as a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("failed"))));
    await expect(request("GET", "/x")).rejects.toMatchObject({ code: NETWORK_ERROR });
  });

  it("tells the shell when the session is rejected", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", respond(401, { code: "unauthorized", message: "No." }));
    await expect(request("GET", "/x")).rejects.toBeInstanceOf(ApiFailure);
    expect(handler).toHaveBeenCalledOnce();
    setUnauthorizedHandler(() => undefined);
  });
});

describe("failure detail", () => {
  it("keeps the structured detail", async () => {
    vi.stubGlobal("fetch", respond(409, { code: "already_decided", message: "No.", detail: { id: "a" } }));
    await expect(request("POST", "/x")).rejects.toMatchObject({ detail: { id: "a" } });
  });
});
