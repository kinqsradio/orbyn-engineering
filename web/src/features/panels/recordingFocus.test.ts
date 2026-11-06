import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// Exercise the exact production CDP expression, not a second copy of its rules.
// This is a predicate contract test; real closed-shadow focus stays in the real
// browser spec and is not qualified by these synthetic document objects.
const source = readFileSync(resolve(process.cwd(), "../crates/orbyn-core/src/browser/preview.rs"), "utf8");
const expression = source.match(/const RECORDING_SAFE_FOCUS: &str = r"([\s\S]*?)";/)?.[1];
if (!expression) throw new Error("Missing production recording focus predicate");

function eligible(tagName: string | null, designMode: string, focused = true, sensitive = false): unknown {
  return runInNewContext(expression!, {
    document: {
      activeElement: tagName ? { tagName, closest: () => sensitive ? {} : null } : null,
      designMode,
      hasFocus: () => focused,
    },
  }, { timeout: 100 });
}

it("body, unknown focus and editing mode never establish label eligibility", () => {
  // BODY is also what a closed shadow input hosted by body exposes to this read.
  for (const tag of ["BODY", "DIV", "IFRAME", "INPUT", "CUSTOM-HOST", null]) {
    expect(eligible(tag, "off")).toBe(false);
  }
  expect(eligible("BUTTON", "on")).toBe(false);
  expect(eligible("A", "on")).toBe(false);
  expect(eligible("BUTTON", "off", false)).toBe(false);
  expect(eligible("BUTTON", "off", true, true)).toBe(false);
  expect(eligible("BUTTON", "off")).toBe(true);
  expect(eligible("A", "off")).toBe(true);
});
