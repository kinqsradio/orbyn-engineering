import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "src/styles");
const files = readdirSync(dir).filter((name) => name.endsWith(".css"));
const css = Object.fromEntries(files.map((name) => [name, readFileSync(join(dir, name), "utf8")]));

const SCALE = new Set(["8", "11", "12", "13", "14", "16", "18", "20", "30", "36"]);
const RADII = new Set(["2", "4", "6", "8", "12", "16", "999"]);

describe("design tokens", () => {
  it("keeps literal colours in the token owner only", () => {
    for (const [name, text] of Object.entries(css)) {
      if (name === "tokens.css") continue;
      expect(text.match(/#[0-9a-f]{3,8}\b/gi), name).toBeNull();
    }
  });

  it("keeps font sizes on the type scale", () => {
    for (const text of Object.values(css)) {
      for (const [, size] of text.matchAll(/font-size:\s*([\d.]+)px/g)) {
        expect(SCALE).toContain(size);
      }
      for (const [, size] of text.matchAll(/--(?:text-[a-z]+|control-fs(?:-sm)?|button-fs):\s*([\d.]+)px/g)) {
        expect(SCALE).toContain(size);
      }
    }
  });

  it("keeps corners on the radius set", () => {
    for (const text of Object.values(css)) {
      for (const [, radius] of text.matchAll(/border-radius:\s*([\d.]+)px/g)) {
        expect(RADII).toContain(radius);
      }
    }
  });
});
