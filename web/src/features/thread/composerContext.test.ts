import { describe, expect, it } from "vitest";
import {
  CHIP_ATTRIBUTE,
  asChip,
  chipPrompt,
  chipsClipboard,
  chipsFromClipboard,
  fileExcerpt,
  languageForPath,
  promptWithChips,
  refillExcerpts,
  type ComposerChip,
} from "./composerContext";

const chip = (over: Record<string, unknown> & Pick<ComposerChip, "kind">): ComposerChip =>
  ({
    id: "c1",
    path: "src/main.rs",
    line: 12,
    excerpt: "let a = 1;",
    language: "rust",
    title: "Terminal selection",
    output: "cargo test\nok",
    comment: "This line is wrong.",
    url: "http://localhost:5173/",
    selector: "#save",
    text: "Clicked save",
    html: "<button id=\"save\">Save</button>",
    threadId: "t1",
    ...over,
  }) as unknown as ComposerChip;

describe("composer context", () => {
  it("renders each kind as a readable prompt block", () => {
    expect(chipPrompt(chip({ kind: "file" }))).toBe("File `src/main.rs:12`\n```rust\nlet a = 1;\n```");
    expect(chipPrompt(chip({ kind: "terminal" }))).toContain("Terminal selection");
    expect(chipPrompt(chip({ kind: "review" }))).toContain("Review on `src/main.rs:12`");
    expect(chipPrompt(chip({ kind: "annotation" }))).toContain("Element `#save`");
    expect(chipPrompt(chip({ kind: "citation" }))).toBe("> Clicked save");
  });

  it("puts chips before the typed draft and keeps a fence inside an excerpt from closing the block", () => {
    const fenced = chip({ kind: "file", excerpt: "```js\ninner\n```" });
    expect(promptWithChips("Please fix this", [fenced])).toBe(
      "File `src/main.rs:12`\n```rust\n` ` `js\ninner\n` ` `\n```\n\nPlease fix this",
    );
    expect(promptWithChips("", [chip({ kind: "citation" })])).toBe("> Clicked save");
  });

  it("round-trips chips through the clipboard's JSON and HTML forms", () => {
    const payload = chipsClipboard([chip({ kind: "file" })]);
    expect(payload).not.toBeNull();
    const fromJson = chipsFromClipboard({ json: payload?.json });
    expect(fromJson?.[0]).toMatchObject({ kind: "file", path: "src/main.rs", excerpt: "let a = 1;" });
    const fromHtml = chipsFromClipboard({ html: payload?.html });
    expect(fromHtml?.[0]).toMatchObject({ kind: "file", path: "src/main.rs" });
    expect(payload?.html).toContain(CHIP_ATTRIBUTE);
    expect(payload?.text).toContain("let a = 1;");
  });

  it("never turns ordinary text, broken JSON or a half-known chip into chips", () => {
    expect(chipsFromClipboard({ json: "not json" })).toBeNull();
    expect(chipsFromClipboard({ json: JSON.stringify({ version: 2, chips: [] }) })).toBeNull();
    expect(chipsFromClipboard({ html: "<p>plain</p>" })).toBeNull();
    const payload = chipsClipboard([
      { id: "x", kind: "file", path: "", line: null, excerpt: null, language: null } as ComposerChip,
    ]);
    expect(payload).toBeNull();
    expect(asChip({ kind: "file", path: "a.ts" })).toMatchObject({ kind: "file", path: "a.ts", line: null });
  });

  it("refetches a pasted file's text and keeps the chip when the read fails", async () => {
    const pasted = chip({ kind: "file", excerpt: null, language: null }) as ComposerChip;
    const filled = await refillExcerpts([pasted], async () => ({ text: "fn main() {}", language: "rust" }));
    expect(filled[0]).toMatchObject({ excerpt: "fn main() {}", language: "rust" });
    const kept = await refillExcerpts([pasted], async () => {
      throw new Error("gone");
    });
    expect(kept[0]).toMatchObject({ path: "src/main.rs", excerpt: null });
  });

  it("reads the language from a path and the lines around a marked one", () => {
    expect(languageForPath("src/lib.rs")).toBe("rust");
    expect(languageForPath("README.unknown")).toBeNull();
    expect(fileExcerpt("one\ntwo\nthree\nfour", 3, 1)).toBe("two\nthree\nfour");
    expect(fileExcerpt("one\ntwo", null, 1)).toBe("one\ntwo");
  });
});
