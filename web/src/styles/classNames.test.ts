import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src");

/** Classes that are meant to carry no rule. Each needs a reason. */
const UNSTYLED = new Map<string, string>();

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

/** Every class a stylesheet defines, wherever it sits in a selector. */
export function definedClasses(css: string): Set<string> {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "");
  return new Set([...rules.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1] ?? ""));
}

/** Static tokens only. A token ending in `-` is the fixed part of `name-${value}`. */
export function classTokens(source: string): string[] {
  const tokens: string[] = [];
  const add = (text: string) => tokens.push(...text.split(/\s+/).filter(Boolean));
  const stringsOf = (expression: string) => {
    for (const match of expression.matchAll(/(===|!==)?\s*(?:"([^"]*)"|`([^`]*)`)/g)) {
      if (match[1]) continue;
      if (match[2] !== undefined) add(match[2]);
      if (match[3] !== undefined) add(match[3].replace(/\$\{[^}]*\}/g, " ").replace(/(\S)\s+$/, "$1"));
    }
  };
  for (const match of source.matchAll(/\b\w*[cC]lassName=(?:"([^"]*)"|\{)/g)) {
    if (match[1] !== undefined) {
      add(match[1]);
      continue;
    }
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < source.length) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") depth -= 1;
      end += 1;
    }
    stringsOf(source.slice(match.index + match[0].length, end - 1));
  }
  return tokens;
}

const files = walk(ROOT);
const css = files
  .filter((file) => file.endsWith(".css"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const defined = definedClasses(css);

const styled = (token: string) =>
  token.endsWith("-") ? [...defined].some((name) => name.startsWith(token)) : defined.has(token);

describe("class names", () => {
  it("reads literals, branches and templates, and skips comparisons", () => {
    const source = [
      `<a className="one two" />`,
      `<b className={open ? "three" : "four"} />`,
      '<c className={`five tint-${tone}`} />',
      `<d className={state === "skipped" ? "six" : "sr-only"} />`,
      `<e summaryClassName="seven" />`,
    ].join("\n");
    expect(classTokens(source)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "tint-",
      "six",
      "sr-only",
      "seven",
    ]);
  });

  it("finds a class only where a rule defines it", () => {
    const found = definedClasses(".card > .card-head:hover { color: red; } /* .ghost */");
    expect([...found]).toEqual(["card", "card-head"]);
  });

  it("has a CSS rule for every static class in the source", () => {
    const missing = files
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.|\/generated\//.test(file))
      .flatMap((file) =>
        classTokens(readFileSync(file, "utf8"))
          .filter((token) => !styled(token) && !UNSTYLED.has(token))
          .map((token) => `${relative(ROOT, file)}: ${token}`),
      );
    expect([...new Set(missing)]).toEqual([]);
  });

  it("keeps the allowlist free of classes that now have a rule", () => {
    expect([...UNSTYLED.keys()].filter((token) => defined.has(token))).toEqual([]);
  });
});
