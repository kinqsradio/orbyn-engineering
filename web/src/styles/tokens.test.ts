import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = join(process.cwd(), "src");

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return stylesheets(path);
    }
    return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
  });
}

// Scanning our entire src tree also covers CSS imported by feature modules.
const css = Object.fromEntries(stylesheets(srcDir).map((path) => [
  relative(srcDir, path).replaceAll("\\", "/"), readFileSync(path, "utf8"),
]));

const SCALE = new Set(["8", "11", "11.5", "12", "12.5", "13", "14", "16", "18", "20", "22", "26", "30", "36"]);
const RADII = new Set(["2", "4", "6", "8", "12", "16", "999"]);

function violations(text: string, pattern: RegExp, allowed: Set<string>, name: string): string[] {
  return Array.from(text.matchAll(pattern), ([declaration, value]) =>
    value !== undefined && allowed.has(value) ? null : `${name}: ${declaration}`,
  ).filter((violation): violation is string => violation !== null);
}

function radiusViolations(text: string, name: string): string[] {
  return Array.from(text.matchAll(/border-radius:\s*([^;{}]+)/g)).flatMap(([, value]) =>
    violations(value ?? "", /([\d.]+)px/g, RADII, name),
  );
}

describe("design tokens", () => {
  it("keeps literal colours in the token owner only", () => {
    for (const [name, text] of Object.entries(css)) {
      if (!name.startsWith("styles/") || name === "styles/tokens.css") continue;
      expect(text.match(/#[0-9a-f]{3,8}\b/gi), name).toBeNull();
    }
  });

  it("keeps font sizes on the type scale", () => {
    for (const [name, text] of Object.entries(css)) {
      expect(violations(text, /font-size:\s*([\d.]+)px/g, SCALE, name)).toEqual([]);
      expect(violations(text, /--(?:text-[a-z]+|control-fs(?:-sm)?|button-fs):\s*([\d.]+)px/g, SCALE, name)).toEqual([]);
    }
  });

  it("keeps corners on the radius set", () => {
    for (const [name, text] of Object.entries(css)) {
      expect(radiusViolations(text, name)).toEqual([]);
    }
  });

  it("reports off-scale values in feature stylesheets", () => {
    const name = "features/settings/ScheduledTasks.css";
    expect(Object.keys(css)).toContain(name);
    const text = ".example { font-size: 17px; border-radius: var(--radius-sm) 7px / 0 50%; }";
    expect(violations(text, /font-size:\s*([\d.]+)px/g, SCALE, name)).toEqual([
      `${name}: font-size: 17px`,
    ]);
    expect(radiusViolations(text, name)).toEqual([
      `${name}: 7px`,
    ]);
  });
});
