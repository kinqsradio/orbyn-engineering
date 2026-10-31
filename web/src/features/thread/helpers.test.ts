import { describe, expect, it } from "vitest";
import type { Thread } from "../../api/types";
import { parsePatch } from "../panels/DiffPanel";
import { arrangeThreads } from "../workspace/groups";
import { touchesOf } from "./approvalDetail";
import type { ThreadItem } from "./projection";
import { insertToken, triggerAt } from "./skillMention";
import { groupWork } from "./timeline";
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
  const base = { seq: 1, runId: "r" };
  it("folds consecutive work and measures its span", () => {
    const entries = groupWork([
      { ...base, kind: "reasoning", key: "a", ts: "2026-10-31T10:00:00Z", text: "", done: true },
      { ...base, kind: "tool", key: "b", ts: "2026-10-31T10:00:20Z", name: "Read", args: "", output: "", result: "ok", done: true },
      { ...base, kind: "message", key: "c", ts: "2026-10-31T10:00:21Z", role: "assistant", text: "hi", done: true },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["work", "message"]);
    expect(entries[0]).toMatchObject({ seconds: 20 });
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
