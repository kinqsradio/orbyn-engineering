import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const folder = join(process.cwd(), "src/styles");

describe("stylesheets", () => {
  // One missing brace nests every later rule under it, and CSS reports nothing.
  it.each(readdirSync(folder).filter((name) => name.endsWith(".css")))("%s closes every block", (name) => {
    const text = readFileSync(join(folder, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    for (const char of text) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
