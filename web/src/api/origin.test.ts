import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopServiceOrigin, serviceSocketUrl, serviceUrl } from "./origin";

const location = (href: string) => new URL(href);
afterEach(() => vi.unstubAllGlobals());

describe("desktop service transport", () => {
  it("uses a changing loopback service without changing the native asset origin", () => {
    for (const origin of ["tauri://localhost", "http://tauri.localhost"]) {
      for (const port of [30001, 30002]) {
        const page = location(`${origin}/?service_origin=http://127.0.0.1:${port}`);
        expect(desktopServiceOrigin(page)).toBe(`http://127.0.0.1:${port}`);
        vi.stubGlobal("window", { location: page });
        expect(serviceUrl("/api/info")).toBe(`http://127.0.0.1:${port}/api/info`);
        expect(serviceSocketUrl("/ws/terminal/t?token=x")).toBe(`ws://127.0.0.1:${port}/ws/terminal/t?token=x`);
      }
    }
  });
  it("ignores launch parameters on ordinary local web pages", () => {
    const page = location("http://127.0.0.1:3000/?service_origin=http://evil.test:99");
    vi.stubGlobal("window", { location: page });
    expect(desktopServiceOrigin(page)).toBeNull();
    expect(serviceUrl("/api/info")).toBe("/api/info");
    expect(serviceSocketUrl("/ws/terminal/t")).toBe("ws://127.0.0.1:3000/ws/terminal/t");
  });
  it("fails closed for a missing, remote, redirected or ambiguous native service address", () => {
    for (const value of ["", "http://evil.test:99", "http://localhost:99", "http://127.0.0.1", "https://127.0.0.1:99", "http://user@127.0.0.1:99", "http://127.0.0.1:99/path", "http://127.0.0.1:99?x=1", "http://127.0.0.1:99/#x", "http://2130706433:99"]) {
      expect(() => desktopServiceOrigin(location(`tauri://localhost/?service_origin=${encodeURIComponent(value)}`))).toThrow();
    }
    vi.stubGlobal("window", { location: location("http://localhost:3000/") });
    for (const path of ["http://evil.test", "//evil.test/api", "/\\evil.test"]) {
      expect(() => serviceUrl(path)).toThrow();
    }
  });
});
