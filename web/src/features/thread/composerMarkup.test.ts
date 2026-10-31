import { describe, expect, it } from "vitest";
import { composerMarkup } from "./composerMarkup";

const joined = (text: string) => composerMarkup(text).map((span) => span.text).join("");
const kinds = (text: string) => composerMarkup(text).map((span) => `${span.kind}:${span.text}`);

describe("composerMarkup", () => {
  it("always joins back into the same text", () => {
    for (const text of [
      "",
      "plain",
      "**bold** and *it* and `code` and ~~gone~~",
      "# Title\n\n- item\n1. one\n> quote\n",
      "```ts\nconst a = 1;\n```\nafter",
      "see [#77 Tidy](https://x.test/77) now",
      "unclosed **bold and `code",
      "a_b_c snake_case and 2 * 3 * 4",
      "é 日本語 🙂 **太字**",
    ]) {
      expect(joined(text)).toBe(text);
    }
  });

  it("marks the kinds of inline text and keeps the markers", () => {
    expect(kinds("a **b** `c`")).toEqual(["text:a ", "marker:**", "bold:b", "marker:**", "text: ", "marker:`", "code:c", "marker:`"]);
    expect(kinds("[x](y)")).toEqual(["link:[x]", "marker:(y)"]);
  });

  it("styles a block by its first characters, and a fence until it closes", () => {
    expect(kinds("## Head")[0]).toBe("marker:## ");
    expect(kinds("## Head")[1]).toBe("heading:Head");
    expect(kinds("- [x] done")[0]).toBe("list:- [x] ");
    expect(kinds("```\n**not bold**\n```\n**bold**")).toContain("fence:**not bold**");
    expect(kinds("```\n**not bold**\n```\n**bold**")).toContain("bold:bold");
  });
});
