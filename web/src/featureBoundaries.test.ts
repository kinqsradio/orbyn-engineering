import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
async function boundaries(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error(`No lint result for ${filePath}`);
  return result.messages.filter((message) => message.ruleId === "architecture/boundaries");
}

describe("feature ownership lint", () => {
  it.each([
    'import { value } from "../panels/private";',
    'export { value } from "../panels/private";',
    'export * from "../panels/private";',
    'const value = import("../panels/private");',
    'type Value = import("../panels/private").Value;',
    'import { value } from "../../features/panels/private";',
    'import { value } from "../panels/public/nested";',
  ])("rejects cross-feature internals: %s", async (code) => {
    expect(await boundaries("src/features/thread/probe.ts", code)).toHaveLength(1);
  });

  it.each([
    'import { value } from "../panels/public";',
    'import { value } from "../panels/public.ts";',
    'import { value } from "./private";',
    'import { value } from "../../state/ui";',
    'const value = import("../panels/public");',
    'type Value = import("../panels/public").Value;',
  ])("allows public composition and inward imports: %s", async (code) => {
    expect(await boundaries("src/features/thread/probe.ts", code)).toHaveLength(0);
  });

  it.each(["ui", "state", "lib", "api", "styles"])("keeps %s inward", async (folder) => {
    for (const code of [
      'import { value } from "../features/thread/public";',
      'const value = import("../features/thread/public");',
      'type Value = import("../app/private").Value;',
    ]) {
      expect(await boundaries(`src/${folder}/probe.ts`, code)).toHaveLength(1);
    }
  });

  it("allows app composition and test fixtures", async () => {
    const code = 'import { value } from "../features/thread/Composer";';
    expect(await boundaries("src/app/probe.ts", code)).toHaveLength(0);
    expect(await boundaries("src/state/probe.test.ts", code)).toHaveLength(0);
  });
});
