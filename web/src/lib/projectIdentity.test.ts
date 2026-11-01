import { describe, expect, it } from "vitest";
import { deriveProjectIdentity, PROJECT_ICON_COLORS } from "./projectIdentity";

describe("automatic project identity", () => {
  it.each([
    ["Orbyn Engineering", "OE"],
    ["alpha beta gamma", "AG"],
    ["Orbyn", "ON"],
    ["A", "AA"],
    ["9", "99"],
    ["T3 Code", "T3"],
    ["12ab", "12"],
    ["2fa app", "2A"],
    ["a٢x９ later", "A٢"],
    ["foo.bar-baz", "FB"],
    ["", "PR"],
    [" \t\n", "PR"],
    ["🧑‍🚀 !!!", "PR"],
  ])("derives %j as %s", (name, monogram) => {
    expect(deriveProjectIdentity(name).monogram).toBe(monogram);
  });

  it.each([
    ["ＡＢＣ　Ｄｅｆ", "AD"],
    ["e\u0301clair", "ÉR"],
    ["中文工具", "中具"],
    ["𐐀tools", "𐐀S"],
    ["ßeta", "SS"],
    ["a\u20ddbc", "AB"],
    ["a\u200db", "AB"],
  ])("uses normalized Unicode word/code-point boundaries for %j", (name, monogram) => {
    expect(deriveProjectIdentity(name).monogram).toBe(monogram);
  });

  it("normalizes compatibility forms and whitespace before deriving both fields", () => {
    expect(deriveProjectIdentity("  Ｔ３　Ｃｏｄｅ\u00a0")).toEqual(deriveProjectIdentity("T3 Code"));
    expect(deriveProjectIdentity("Cafe\u0301")).toEqual(deriveProjectIdentity("Café"));
    expect(deriveProjectIdentity("orbyn engineering")).toEqual(deriveProjectIdentity("ORBYN ENGINEERING"));
  });

  // Fixed fixtures were calculated with independently weighted polynomial terms,
  // reducing modulo 18 rather than wrapping a 32-bit hash.
  it.each([
    ["Orbyn Engineering", "amber"],
    ["T3 Code", "pink"],
    ["", "fuchsia"],
    ["   ", "fuchsia"],
    ["project", "fuchsia"],
    ["Ｃａｆé", "fuchsia"],
    ["İstanbul", "fuchsia"],
    ["𐐀tools", "cyan"],
    ["e\u0301clair", "gray"],
    ["a".repeat(4096), "pink"],
    ["A".repeat(256) + "🚀", "pink"],
  ])("keeps the stable palette result for %j", (name, color) => {
    expect(deriveProjectIdentity(name).color).toBe(color);
  });

  it("exposes all eighteen ordered named colors for badge and picker consumers", () => {
    const expected = ["gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
      "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"];
    expect(PROJECT_ICON_COLORS).toEqual(expected);
    // The eighteen consecutive lowercase/punctuation code points have each
    // distinct remainder, independently exercising every palette slot.
    expect(Array.from({ length: 18 }, (_, index) =>
      deriveProjectIdentity(String.fromCodePoint(108 + index)).color)).toEqual(expected);
  });
});
