import { describe, expect, it } from "vitest";
import type { Thread } from "../../api/types";
import {
  arrangeThreads,
  dropPatch,
  dropVerb,
  foldersOf,
  projectDrop,
  sectionOf,
  sweepIds,
  threadsFlat,
} from "./groups";

const now = Date.parse("2026-10-31T12:00:00Z");

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
} as NonNullable<Thread["lifecycle"]>;

const thread = (
  id: string,
  life: Partial<NonNullable<Thread["lifecycle"]>> = {},
  over: Partial<Thread> = {},
): Thread =>
  ({
    id,
    project_id: "p",
    title: id,
    active_run: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
    lifecycle: { ...lifecycle, ...life },
    ...over,
  }) as Thread;

const running = { active_run: { id: "r", state: "running" } as Thread["active_run"] };

describe("sidebar sections", () => {
  it("places each lifecycle", () => {
    expect(sectionOf(thread("a", { pinned_at: "x" }), now, null)).toBe("pinned");
    expect(sectionOf(thread("a", { settled_at: "x" }), now, null)).toBe("settled");
    expect(sectionOf(thread("a", { archived_at: "x" }), now, null)).toBeNull();
    expect(sectionOf(thread("a", { snoozed_until: "2026-11-01T00:00:00Z" }), now, null)).toBe("snoozed");
    expect(sectionOf(thread("a", { snoozed_until: "2026-10-01T00:00:00Z" }), now, null)).toBe("active");
  });

  it("keeps the open thread in the list while it runs, and others on the shelf", () => {
    expect(sectionOf(thread("a", {}, running), now, "a")).toBe("active");
    expect(sectionOf(thread("a", {}, running), now, "b")).toBe("working");
    const waiting = { active_run: { id: "r", state: "awaiting_approval" } as Thread["active_run"] };
    expect(sectionOf(thread("a", {}, waiting), now, "b")).toBe("active");
  });

  it("orders by the saved position, not by activity", () => {
    const sections = arrangeThreads(
      [
        thread("later", { position: 2 }, { updated_at: "2026-10-31T11:00:00Z" }),
        thread("first", { position: -1 }),
      ],
      now,
      null,
    );
    expect(sections.active.map((t) => t.id)).toEqual(["first", "later"]);
  });
});

describe("drops", () => {
  it("names the action, and has none for shelves that refuse drops", () => {
    expect(dropVerb("active", "pinned")).toBe("pin");
    expect(dropVerb("pinned", "active")).toBe("unpin");
    expect(dropVerb("active", "settled")).toBe("settle");
    expect(dropVerb("settled", "active")).toBe("unsettle");
    expect(dropVerb("snoozed", "active")).toBe("wake");
    expect(dropVerb("active", "active")).toBeNull();
    expect(dropVerb("active", "working")).toBeNull();
    expect(dropVerb("active", null)).toBeNull();
  });

  it("patches exactly what the move needs", () => {
    expect(dropPatch("active", "active")).toBeNull();
    expect(dropPatch("active", "pinned")).toEqual({ pinned: true });
    expect(dropPatch("pinned", "active")).toEqual({ pinned: false });
    expect(dropPatch("settled", "pinned")).toEqual({ settled: false, pinned: true });
    expect(dropPatch("snoozed", "active")).toEqual({ wake: true });
    expect(dropPatch("pinned", "settled")).toEqual({ settled: true });
  });

  it("projects a move across sections", () => {
    const sections = arrangeThreads([thread("a"), thread("b", { position: 1 }), thread("p", { pinned_at: "x" })], now, null);
    const moved = projectDrop(sections, "b", { section: "pinned", index: 0 });
    expect(moved.pinned.map((t) => t.id)).toEqual(["b", "p"]);
    expect(moved.active.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("press-drag", () => {
  it("covers rows between origin and target that pass the filter", () => {
    const rows = threadsFlat(
      arrangeThreads(
        [
          thread("a", { position: 0 }),
          thread("b", { position: 1 }),
          thread("c", { position: 2 }),
          thread("s", { settled_at: "x" }),
        ],
        now,
        null,
      ),
    );
    const active = (t: Thread) => !t.lifecycle?.settled_at;
    expect(sweepIds(rows, "c", "a", active)).toEqual(["a", "b", "c"]);
    expect(sweepIds(rows, "b", "s", active)).toEqual(["b", "c"]);
  });
});

describe("folders", () => {
  const project = (id: string, created_at: string) =>
    ({ id, name: id, path: id, trusted: true, is_git: true, managed: false, scratch: false, created_at }) as const;

  it("sorts projects by latest activity and threads by the chosen field", () => {
    const folders = foldersOf(
      [project("old", "2026-01-01T00:00:00Z"), project("new", "2026-02-01T00:00:00Z")],
      [
        thread("x", {}, { project_id: "old", updated_at: "2026-10-31T00:00:00Z" }),
        thread("y", {}, { project_id: "new", updated_at: "2026-10-30T00:00:00Z" }),
      ],
      "updated_at",
      "updated_at",
    );
    expect(folders.map((folder) => folder.project.id)).toEqual(["old", "new"]);
  });
});

describe("the open thread's section", () => {
  it("stays active when it settles on its own, until you leave", () => {
    const settled = thread("a", { settled_at: "2026-10-31T11:00:00Z" });
    expect(sectionOf(settled, now, "a", "active")).toBe("active");
    expect(sectionOf(settled, now, null, "active")).toBe("settled");
    expect(sectionOf(settled, now, "a", "settled")).toBe("settled");
  });
});
