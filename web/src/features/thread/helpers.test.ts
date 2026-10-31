import { describe, expect, it } from "vitest";
import type { Thread } from "../../api/types";
import { parsePatch } from "../panels/DiffPanel";
import { arrangeThreads } from "../workspace/groups";
import { touchesOf } from "./approvalDetail";
import { percentLabel } from "./ComposerExtras";
import type { ThreadItem } from "./projection";
import { insertToken, triggerAt } from "./skillMention";
import { outputSpans } from "./ansi";
import type { ToolItem } from "./projection";
import { arrangeTimeline, groupWork } from "./timeline";
import { summarizeWork } from "./toolTrace";
import { withLocalPrompts } from "./Transcript";

describe("triggers", () => {
  it("finds a token at the caret only at a word start", () => {
    expect(triggerAt("use $ar", 7)).toEqual({ char: "$", start: 4, query: "ar" });
    expect(triggerAt("@src/ma", 7)).toEqual({ char: "@", start: 0, query: "src/ma" });
    expect(triggerAt("cost$ar", 7)).toBeNull();
    expect(triggerAt("$ar then", 8)).toBeNull();
  });

  it("takes / only at the start of the prompt", () => {
    expect(triggerAt("/re", 3)).toEqual({ char: "/", start: 0, query: "re" });
    expect(triggerAt("see /re", 7)).toBeNull();
  });

  it("replaces the query and places the caret after it", () => {
    const trigger = { char: "$", start: 4, query: "ar" } as const;
    expect(insertToken("use $ar now", 7, trigger, "architect")).toEqual({
      text: "use $architect  now",
      caret: 15,
    });
  });
});

describe("groupThreads", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  const thread = (id: string, hoursAgo: number, over: Partial<Thread> = {}) =>
    ({
      id,
      active_run: null,
      last_run_state: "completed",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
      ...over,
    }) as Thread;

  it("separates active, recent and settled", () => {
    const groups = arrangeThreads(
      [
        thread("new", 1),
        thread("old", 30),
        thread("failed", 90, { last_run_state: "failed" }),
        thread("live", 200, { active_run: { id: "r" } as Thread["active_run"] }),
      ],
      now,
      null,
    );
    expect(groups.working.map((t) => t.id)).toEqual(["live"]);
    expect(groups.active.map((t) => t.id).sort()).toEqual(["failed", "new"]);
    expect(groups.settled.map((t) => t.id)).toEqual(["old"]);
  });

  it("follows the server's lifecycle when present", () => {
    const lifecycle = {
      pinned_at: null,
      archived_at: null,
      settled_at: null,
      snoozed_until: null,
      unread: false,
      auto_settle: null,
      position: 0,
      parent_thread_id: null,
      relation: null,
      permission_mode: "supervised",
      plan_mode: false,
    } satisfies Thread["lifecycle"];
    const groups = arrangeThreads(
      [
        thread("kept", 300, { lifecycle }),
        thread("done", 1, { lifecycle: { ...lifecycle, settled_at: "2026-10-31T11:00:00Z" } }),
        thread("gone", 1, { lifecycle: { ...lifecycle, archived_at: "2026-10-31T11:00:00Z" } }),
      ],
      now,
      null,
    );
    expect(groups.active.map((t) => t.id)).toEqual(["kept"]);
    expect(groups.settled.map((t) => t.id)).toEqual(["done"]);
    expect(groups.working).toEqual([]);
  });
});

describe("groupWork", () => {
  const base = { seq: 1, runId: "r", ts: "2026-10-31T10:00:00Z" };
  it("joins neighbouring work and leaves messages out", () => {
    const entries = groupWork([
      { ...base, kind: "reasoning", key: "a", text: "", done: true },
      { ...base, kind: "tool", key: "b", name: "Read", args: "", output: "", result: "ok", done: true, exitCode: null },
      { ...base, kind: "message", key: "c", role: "assistant", text: "hi", done: true },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["work", "message"]);
  });
});

describe("arrangeTimeline", () => {
  const at = (seconds: number) => `2026-10-31T10:00:${String(seconds).padStart(2, "0")}Z`;
  const base = { seq: 1, runId: "r" };
  const items: ThreadItem[] = [
    { ...base, ts: at(0), kind: "message", key: "u", role: "user", text: "go", done: true },
    { ...base, ts: at(1), kind: "message", key: "m1", role: "assistant", text: "looking", done: true },
    { ...base, ts: at(2), kind: "tool", key: "t", name: "command", args: "{}", output: "", result: "x", done: true, exitCode: 0 },
    { ...base, ts: at(3), kind: "message", key: "m2", role: "assistant", text: "done", done: true },
  ];
  it("folds a finished turn down to the prompt and the answer", () => {
    const span = { startedAt: at(0), endedAt: at(49), outcome: "success" as const };
    const entries = arrangeTimeline(items, { r: span }, null);
    expect(entries.map((entry) => entry.kind)).toEqual(["message", "fold", "message"]);
    expect(entries[1]).toMatchObject({ label: "Worked for 49s" });
  });
  it("says who stopped a turn", () => {
    const span = { startedAt: at(0), endedAt: at(9), outcome: "cancelled" as const };
    expect(arrangeTimeline(items, { r: span }, null)[1]).toMatchObject({ label: "You stopped after 9s" });
  });
  it("keeps a running turn open under its header", () => {
    const span = { startedAt: at(0), endedAt: null, outcome: null };
    const kinds = arrangeTimeline(items, { r: span }, "r").map((entry) => entry.kind);
    expect(kinds).toEqual(["message", "working", "message", "work", "message"]);
  });
});

describe("summarizeWork", () => {
  const tool = (name: string, args: unknown, exitCode: number | null = 0): ToolItem => ({
    seq: 1, runId: "r", ts: "", kind: "tool", key: name, name, args: JSON.stringify(args), output: "", result: "", done: true, exitCode,
  });
  it("names up to two kinds of work and counts the rest", () => {
    const { summary } = summarizeWork([
      tool("command", { command: "ls" }),
      tool("command", { command: "pwd" }),
      tool("file_change", { paths: ["a", "b"] }),
      tool("web_search", { query: "x" }),
    ]);
    expect(summary).toBe("Ran 2 commands, changed 2 files, and performed 1 other action");
  });
  it("marks a failed command", () => {
    expect(summarizeWork([tool("Bash", { command: "x" }, 1)])).toMatchObject({ summary: "Ran 1 command", failed: true });
  });
  it("calls reasoning alone a thought", () => {
    const thought = { seq: 1, runId: "r", ts: "", kind: "reasoning" as const, key: "r", text: "", done: true };
    expect(summarizeWork([thought, thought]).summary).toBe("Thought (×2)");
  });
});

describe("outputSpans", () => {
  it("strips escapes and keeps colour", () => {
    expect(outputSpans("\u001b[32mok\u001b[0m plain\u001b]0;title\u0007")).toEqual([
      { text: "ok", color: "var(--ansi-green)", bold: false },
      { text: " plain", color: null, bold: false },
    ]);
  });
});

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

describe("percentLabel", () => {
  it("keeps a small share readable", () => {
    expect(percentLabel(0.4)).toBe("0.4%");
    expect(percentLabel(3)).toBe("3%");
    expect(percentLabel(42.6)).toBe("43%");
  });
});
