import { describe, expect, it } from "vitest";
import { findLinks } from "./terminalLinks";

describe("findLinks", () => {
  it("finds each address and leaves the sentence's punctuation out", () => {
    expect(findLinks("Local: http://localhost:5173/, then https://a.test/b?c=1.")).toEqual([
      { url: "http://localhost:5173/", start: 7, end: 29 },
      { url: "https://a.test/b?c=1", start: 36, end: 56 },
    ]);
  });

  it("ignores text with no address", () => {
    expect(findLinks("build finished in 3s")).toEqual([]);
  });
});
