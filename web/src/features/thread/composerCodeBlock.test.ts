import { describe, expect, it } from "vitest";
import {
  CODE_LANGUAGES,
  exitCodeBlock,
  indentCodeLines,
  openFenceAt,
  setFenceLanguage,
} from "./composerCodeBlock";

const draft = "Before\n```rust\nlet a = 1;\n```\nAfter";

describe("composer code blocks", () => {
  it("finds the fence the caret is inside and not the one outside it", () => {
    const inside = openFenceAt(draft, draft.indexOf("let a"));
    expect(inside?.language).toBe("rust");
    expect(draft.slice(inside?.contentStart)).toMatch(/^let a/);
    expect(openFenceAt(draft, 2)).toBeNull();
    expect(openFenceAt(draft, draft.indexOf("After"))).toBeNull();
  });

  it("ignores a fence marker that has more than three backticks or a longer indent", () => {
    expect(openFenceAt("````js\ncode", 8)).toBeNull();
    expect(openFenceAt("    ```js\ncode", 12)).toBeNull();
  });

  it("indents every selected code line by two spaces and lifts it again", () => {
    const text = "```ts\none\ntwo\n```";
    const nested = indentCodeLines(text, 7, 12, false);
    expect(nested?.text).toBe("```ts\n  one\n  two\n```");
    const lifted = indentCodeLines(nested?.text ?? "", nested?.start ?? 0, nested?.end ?? 0, true);
    expect(lifted?.text).toBe(text);
  });

  it("keeps a multi-line selection on the same text through Tab and Shift+Tab", () => {
    const text = "```ts\none\ntwo\n```";
    const nested = indentCodeLines(text, 7, 12, false);
    expect(nested?.text.slice(nested.start, nested.end)).toBe("ne\n  tw");
    const lifted = indentCodeLines(nested?.text ?? "", nested?.start ?? 0, nested?.end ?? 0, true);
    expect(lifted).toMatchObject({ start: 7, end: 12 });
    expect(lifted?.text.slice(lifted.start, lifted.end)).toBe("ne\ntw");
  });

  it("leaves Tab outside a code block to the list and focus rules", () => {
    expect(indentCodeLines("plain\nlines", 2, 2, false)).toBeNull();
    expect(indentCodeLines("```\ncode\n```", 8, 8, true)).toBeNull();
  });

  it("closes the block on Enter from its empty last line", () => {
    const text = "```js\nlet a = 1;\n";
    const next = exitCodeBlock(text, text.length);
    expect(next?.text).toBe("```js\nlet a = 1;\n```\n");
    expect(next?.caret).toBe(next?.text.length);
    expect(exitCodeBlock(text, 8)).toBeNull();
  });

  it("sets and clears the language on the opening line", () => {
    const fence = openFenceAt("```\ncode", 5);
    expect(fence).not.toBeNull();
    const named = setFenceLanguage("```\ncode", fence!, "python");
    expect(named).toBe("```python\ncode");
    expect(setFenceLanguage(named, openFenceAt(named, 10)!, "")).toBe("```\ncode");
  });

  it("offers plain text and the common languages", () => {
    expect(CODE_LANGUAGES[0]).toBe("");
    expect(CODE_LANGUAGES).toContain("rust");
    expect(CODE_LANGUAGES).toContain("typescript");
  });
});
