import { describe, expect, it } from "vitest";
import { accentColor, newInstanceId, patchInstance, readInstance, validInstanceId } from "./providerInstanceData";

describe("provider instance edits", () => {
  it("preserves peer records and unknown fields when editing one disabled instance", () => {
    const peer = { id: "other", driver: "codex", future: { nested: true }, args: ["literal space"] };
    const mine = { id: "work", driver: "claude", enabled: false, name: "old", future: 42 };
    const result = patchInstance([peer, mine, { opaque: "forward record" }], "work", { name: "Work" });
    expect(result).toEqual([peer, { ...mine, name: "Work" }, { opaque: "forward record" }]);
    expect(result[0]).toBe(peer); expect(mine.name).toBe("old");
    expect(readInstance(mine)?.enabled).toBe(false);
  });
  it("clears only selected optional fields without normalizing other values", () => {
    expect(patchInstance([{ id: "work", driver: "acp-one", name: "Work", program: "old", args: ["--name", "space stays"] }], "work", { program: undefined }))
      .toEqual([{ id: "work", driver: "acp-one", name: "Work", args: ["--name", "space stays"] }]);
  });
  it("refuses missing or ambiguous identities rather than adding or fanout", () => {
    expect(() => patchInstance([], "gone", { enabled: false })).toThrow();
    expect(() => patchInstance([{ id: "same", driver: "one" }, { id: "same", driver: "two" }], "same", { name: "x" })).toThrow();
  });
  it("derives collision-free instance ids separately from driver identities", () => {
    const id = newInstanceId("claude", "  Work Space  ", new Set(["claude_work_space"]));
    expect(id).toBe("claude_work_space_2"); expect(validInstanceId(id)).toBe(true);
    expect(validInstanceId("../engine")).toBe(false); expect(validInstanceId("x".repeat(65))).toBe(false);
  });
  it("normalizes only valid hex accent values", () => {
    expect(accentColor("#ABCDEF")).toBe("#abcdef"); expect(accentColor("red")).toBeNull(); expect(accentColor("url(x)")).toBeNull();
  });
});
