import { describe, expect, it } from "vitest";
import { findFileLinks, findLinks, findTerminalLinks } from "./terminalLinks";

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

describe("findFileLinks", () => {
  it("finds relative, explicit relative, absolute and Windows paths", () => {
    const line = "src/app.ts ./index.html ../up.ts /Users/me/repo/a.css C:\\repo\\src\\b.ts";
    expect(findFileLinks(line).map(({ path, line: at, column }) => [path, at, column])).toEqual([
      ["src/app.ts", null, null],
      ["./index.html", null, null],
      ["../up.ts", null, null],
      ["/Users/me/repo/a.css", null, null],
      ["C:\\repo\\src\\b.ts", null, null],
    ]);
  });

  it("keeps a line and column suffix off the path", () => {
    expect(findFileLinks("src/app.ts:12:5 and src/b.ts:7.").map(({ path, line, column }) => [path, line, column])).toEqual([
      ["src/app.ts", 12, 5],
      ["src/b.ts", 7, null],
    ]);
  });

  it("keeps offsets on the path and leaves the sentence's punctuation out", () => {
    expect(findFileLinks("See (src/app.ts:12), then done.")).toEqual([
      { path: "src/app.ts", line: 12, column: null, start: 5, end: 18 },
    ]);
  });

  it("ignores bare words, hosts and folders", () => {
    expect(findFileLinks("build finished in 3s; see README.md at localhost:5173 and src/")).toEqual([]);
  });

  it("does not take a path out of an address", () => {
    expect(findFileLinks("open http://localhost:5173/src/app.ts now")).toEqual([]);
  });
});

describe("findTerminalLinks", () => {
  it("returns addresses and files left to right without overlap", () => {
    expect(findTerminalLinks("open http://localhost:5173/x and src/app.ts")).toEqual([
      { kind: "url", url: "http://localhost:5173/x", start: 5, end: 28 },
      { kind: "file", path: "src/app.ts", line: null, column: null, start: 33, end: 43 },
    ]);
  });
});
