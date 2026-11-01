import { describe, expect, it } from "vitest";
import { captureToken, readToken } from "./token";

describe("captureToken", () => {
  it("moves the token to sessionStorage and clears it from the URL", () => {
    window.history.replaceState(null, "", "/?token=abc&keep=1&service_origin=http%3A%2F%2F127.0.0.1%3A3001#/threads/t");
    captureToken();
    expect(readToken()).toBe("abc");
    expect(window.location.search).toBe("?keep=1&service_origin=http%3A%2F%2F127.0.0.1%3A3001");
    expect(window.location.hash).toBe("#/threads/t");
    window.history.replaceState(null, "", "/");
  });

  it("leaves the URL alone without a token", () => {
    window.history.replaceState(null, "", "/?a=1");
    captureToken();
    expect(readToken()).toBeNull();
    expect(window.location.search).toBe("?a=1");
    window.history.replaceState(null, "", "/");
  });
});
