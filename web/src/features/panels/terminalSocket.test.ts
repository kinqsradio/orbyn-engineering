import { describe, expect, it } from "vitest";
import { terminalUrl } from "./terminalSocket";

describe("terminalUrl", () => {
  it("carries the token in the query, as browsers can't set headers", () => {
    sessionStorage.setItem("orbyn.token", "a b");
    expect(terminalUrl("t/1", { protocol: "https:", host: "h:1" })).toBe(
      "wss://h:1/ws/terminal/t%2F1?token=a%20b",
    );
  });

  it("omits the token for cookie sessions", () => {
    expect(terminalUrl("t", { protocol: "http:", host: "h" })).toBe("ws://h/ws/terminal/t");
  });
});
