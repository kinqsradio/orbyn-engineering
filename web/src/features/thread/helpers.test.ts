import { describe, expect, it } from "vitest";
import { parsePatch } from "../panels/DiffPanel";
import { touchesOf } from "./approvalDetail";
import type { ThreadItem } from "./projection";
import { withLocalPrompts } from "./Transcript";

describe("touchesOf", () => {
  it("picks known fields", () => {
    expect(touchesOf({ command: "ls", paths: ["a", "b"], url: "https://x" })).toEqual([
      { label: "Command", values: ["ls"], mono: true },
      { label: "Files", values: ["a", "b"], mono: true },
      { label: "Address", values: ["https://x"], mono: true },
    ]);
  });

  it("returns nothing for shapes it does not know", () => {
    expect(touchesOf({ other: 1 })).toEqual([]);
    expect(touchesOf(null)).toEqual([]);
  });
});

describe("parsePatch", () => {
  it("classifies lines without treating file headers as changes", () => {
    const lines = parsePatch("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same\n");
    expect(lines.map((line) => line.kind)).toEqual(["meta", "meta", "hunk", "del", "add", "ctx"]);
  });
});

describe("withLocalPrompts", () => {
  const assistant = {
    kind: "message",
    key: "m",
    seq: 1,
    ts: "",
    runId: "r",
    role: "assistant",
    text: "hi",
    done: true,
  } satisfies ThreadItem;

  it("places an unechoed prompt before its run", () => {
    const merged = withLocalPrompts([assistant], [{ runId: "r", text: "q" }]);
    expect(merged.map((item) => item.kind === "message" && item.text)).toEqual(["q", "hi"]);
  });

  it("drops a prompt the log has echoed", () => {
    const echoed = { ...assistant, key: "u", role: "user", text: "q" };
    expect(withLocalPrompts([echoed], [{ runId: "r", text: "q" }])).toHaveLength(1);
  });
});
