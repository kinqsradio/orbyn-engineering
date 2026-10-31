import { describe, expect, it } from "vitest";
import { dropTrailingSlash, expandHome, replaceHomePrefix, shortenHome, splitPath, withSlash } from "./pathInput";

describe("replaceHomePrefix", () => {
  it.each([
    ["~//Users/me/code", "/Users/me/code"],
    ["~//", "/"],
    ["~/~", "~"],
    ["~/~/code", "~/code"],
    ["~/C:\\Users\\me", "C:\\Users\\me"],
    ["~/c:/Users", "c:/Users"],
    ["~/\\\\server\\share", "\\\\server\\share"],
    ["  ~//Users", "/Users"],
    ["  /Users/me", "/Users/me"],
  ])("lets %s replace the prefix", (typed, expected) => {
    expect(replaceHomePrefix(typed)).toBe(expected);
  });

  it.each(["~/", "~/code", "~/code/C:\\x", "/Users/me", "C:\\Users", "~", ""])("keeps %s as typed", (typed) => {
    expect(replaceHomePrefix(typed)).toBe(typed);
  });
});

describe("splitPath", () => {
  it("treats a bare ~ as home", () => expect(splitPath("~")).toEqual({ dir: "~/", leaf: "" }));
  it("splits Windows paths", () => expect(splitPath("C:\\Users\\me")).toEqual({ dir: "C:\\Users\\", leaf: "me" }));
});

describe("home", () => {
  it("expands a bare ~ and both separators", () => {
    expect(expandHome("~", "/Users/me")).toBe("/Users/me/");
    expect(expandHome("~/code", "/Users/me")).toBe("/Users/me/code");
    expect(expandHome("~\\code", "C:\\Users\\me")).toBe("C:\\Users\\me\\code");
  });
  it("shortens under home on Windows too", () => {
    expect(shortenHome("C:\\Users\\me\\code", "C:\\Users\\me")).toBe("~/code");
    expect(shortenHome("D:\\code", "C:\\Users\\me")).toBe("D:\\code");
  });
  it("adds the path's own separator", () => {
    expect(withSlash("C:\\code")).toBe("C:\\code\\");
    expect(withSlash("/code")).toBe("/code/");
  });
});

describe("dropTrailingSlash", () => {
  it.each([
    ["/Users/me/", "/Users/me"],
    ["C:\\code\\", "C:\\code"],
    ["/", "/"],
    ["C:\\", "C:\\"],
    ["C:/", "C:/"],
  ])("turns %s into %s", (path, expected) => expect(dropTrailingSlash(path)).toBe(expected));
});
