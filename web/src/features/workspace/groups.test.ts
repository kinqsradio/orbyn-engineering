import { describe, expect, it } from "vitest";
import type { Thread } from "../../api/types";
import {
  arrangeThreads,
  attentionRank,
  dropPatch,
  drawnOrder,
  dropVerb,
  foldersOf,
  ledgerGroupsOf,
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
    expect(sectionOf(thread("a", { pinned_at: "x" }), now)).toBe("pinned");
    expect(sectionOf(thread("a", { settled_at: "x" }), now)).toBe("settled");
    expect(sectionOf(thread("a", { archived_at: "x" }), now)).toBeNull();
    expect(sectionOf(thread("a", { snoozed_until: "2026-11-01T00:00:00Z" }), now)).toBe("snoozed");
    expect(sectionOf(thread("a", { snoozed_until: "2026-10-01T00:00:00Z" }), now)).toBe("active");
  });

  it("puts running threads on the working shelf regardless of the open route", () => {
    expect(sectionOf(thread("a", {}, running), now)).toBe("working");
    const waiting = { active_run: { id: "r", state: "awaiting_approval" } as Thread["active_run"] };
    expect(sectionOf(thread("a", {}, waiting), now)).toBe("active");
  });

  it("orders by the saved position, not by activity", () => {
    const sections = arrangeThreads(
      [
        thread("later", { position: 2 }, { updated_at: "2026-10-31T11:00:00Z" }),
        thread("first", { position: -1 }),
      ],
      now,
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
    const sections = arrangeThreads([thread("a"), thread("b", { position: 1 }), thread("p", { pinned_at: "x" })], now);
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
      ),
    );
    const active = (t: Thread) => !t.lifecycle?.settled_at;
    expect(sweepIds(rows, "c", "a", active)).toEqual(["a", "b", "c"]);
    expect(sweepIds(rows, "b", "s", active)).toEqual(["b", "c"]);
  });
});

describe("folders", () => {
  const project = (id: string, created_at: string, name = id) =>
    ({ id, name, path: `/work/${id}`, trusted: true, is_git: true, managed: false, scratch: false, created_at }) as const;

  it("sorts projects by latest activity and threads by the chosen field", () => {
    const folders = foldersOf(
      [project("old", "2026-01-01T00:00:00Z"), project("new", "2026-02-01T00:00:00Z")],
      [
        thread("x", {}, { project_id: "old", updated_at: "2026-10-31T00:00:00Z" }),
        thread("y", {}, { project_id: "new", updated_at: "2026-10-30T00:00:00Z" }),
      ],
      null,
      "updated_at",
      "updated_at",
    );
    expect(folders.map((folder) => folder.key)).toEqual(["old", "new"]);
    expect(folders[0]?.label).toBe("old");
  });

  it("keeps checkouts of one repository in one folder", () => {
    const folders = foldersOf(
      [project("one", "2026-01-01T00:00:00Z"), project("two", "2026-02-01T00:00:00Z")],
      [
        thread("a", {}, { project_id: "one", updated_at: "2026-10-30T00:00:00Z" }),
        thread("b", {}, { project_id: "two", updated_at: "2026-10-31T00:00:00Z" }),
      ],
      [{ key: "repo", label: "Owner/Repo", projectIds: ["one", "two"] }],
      "updated_at",
      "updated_at",
    );
    expect(folders).toHaveLength(1);
    expect(folders[0]?.label).toBe("Owner/Repo");
    expect(folders[0]?.projects.map((member) => member.id)).toEqual(["one", "two"]);
    expect(folders[0]?.threads.map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("keeps a checkout missing from the catalog in its own folder", () => {
    const folders = foldersOf(
      [project("one", "2026-01-01T00:00:00Z"), project("two", "2026-02-01T00:00:00Z")],
      [thread("a", {}, { project_id: "one" }), thread("b", {}, { project_id: "two" })],
      [{ key: "repo", label: "Owner/Repo", projectIds: ["one"] }],
      "updated_at",
      "updated_at",
    );
    expect(folders.map((folder) => folder.label).sort()).toEqual(["Owner/Repo", "two"]);
    expect(new Set(folders.flatMap((folder) => folder.threads.map((row) => row.id))).size).toBe(2);
  });

  it("keys a one-checkout group by its project so saved open state survives", () => {
    const projects = [project("one", "2026-01-01T00:00:00Z"), project("two", "2026-02-01T00:00:00Z")];
    const rows = [thread("a", {}, { project_id: "one" }), thread("b", {}, { project_id: "two" })];
    const keys = (grouping: Parameters<typeof foldersOf>[2]) =>
      foldersOf(projects, rows, grouping, "updated_at", "updated_at").map((folder) => folder.key).sort();
    const separate = [
      { key: "hash-one", label: "one", projectIds: ["one"] },
      { key: "hash-two", label: "two", projectIds: ["two"] },
    ];
    expect(keys(separate)).toEqual(keys(null));
    expect(keys(separate)).toEqual(["one", "two"]);
    // A shared group keeps its catalog key even when a filter hides a member.
    expect(foldersOf([projects[0]!], rows, [{ key: "repo", label: "Owner/Repo", projectIds: ["one", "two"] }],
      "updated_at", "updated_at").map((folder) => folder.key)).toEqual(["repo"]);
  });

  it("sorts threads inside a group by the chosen field", () => {
    const folders = foldersOf(
      [project("one", "2026-01-01T00:00:00Z"), project("two", "2026-01-01T00:00:00Z")],
      [
        thread("old", {}, { project_id: "one", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-10-31T00:00:00Z" }),
        thread("new", {}, { project_id: "two", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-30T00:00:00Z" }),
      ],
      [{ key: "repo", label: "Owner/Repo", projectIds: ["one", "two"] }],
      "updated_at",
      "created_at",
    );
    expect(folders[0]?.threads.map((row) => row.id)).toEqual(["new", "old"]);
  });
});

describe("lifecycle changes", () => {
  it("moves to settled as soon as the lifecycle changes", () => {
    const active = thread("a");
    const settled = thread("a", { settled_at: "2026-10-31T11:00:00Z" });
    expect(sectionOf(active, now)).toBe("active");
    expect(sectionOf(settled, now)).toBe("settled");
    expect(settled.lifecycle?.settled_at).toBe("2026-10-31T11:00:00Z");
  });

  it("keeps running and watched threads active when the working shelf is off", () => {
    const rows = [thread("running", {}, running), thread("watched", { watching: true })];
    expect(arrangeThreads(rows, now, false).active.map((item) => item.id)).toEqual(["running", "watched"]);
    expect(arrangeThreads(rows, now).working.map((item) => item.id)).toEqual(["running", "watched"]);
  });
});

describe("ledger order", () => {
  const waiting = { active_run: { id: "r", state: "awaiting_approval" } as Thread["active_run"] };
  const failed = { last_run_state: "failed" } as Partial<Thread>;

  it("ranks needing you before failed before the rest", () => {
    expect(attentionRank(thread("a", {}, waiting))).toBe(0);
    expect(attentionRank(thread("a", { limit: { kind: "usage" } } as never))).toBe(0);
    expect(attentionRank(thread("a", {}, failed))).toBe(1);
    expect(attentionRank(thread("a"))).toBe(2);
  });

  it("lists active threads that need you first only when asked", () => {
    const threads = [thread("plain", { position: 0 }), thread("broke", { position: 1 }, failed), thread("asks", { position: 2 }, waiting)];
    expect(arrangeThreads(threads, now).active.map((t) => t.id)).toEqual(["plain", "broke", "asks"]);
    expect(arrangeThreads(threads, now, true, true).active.map((t) => t.id)).toEqual(["asks", "broke", "plain"]);
  });
});

describe("drawn order", () => {
  const waiting = { active_run: { id: "r", state: "awaiting_approval" } as Thread["active_run"] };
  const failed = { last_run_state: "failed" } as Partial<Thread>;
  const project = (id: string) => ({ id, name: id }) as never;
  const open = () => true;
  const base = { strays: [], folderOpen: open, groupOpen: open, settled: [] as Thread[] };

  it("follows Ledger's groups, with running before done", () => {
    const threads = [
      thread("done1", { position: 0 }),
      thread("run1", { position: 1 }, running),
      thread("fail1", { position: 2 }, failed),
      thread("ask1", { position: 3 }, waiting),
      thread("done2", { position: 4 }),
      thread("run2", { position: 5 }, running),
    ];
    const sections = arrangeThreads(threads, now, false, true);
    // The saved order inside `active` is already the drawn order, so a drop index is a screen position.
    expect(sections.active.map((t) => t.id)).toEqual(["ask1", "fail1", "run1", "run2", "done1", "done2"]);
    expect(ledgerGroupsOf(sections.active).map((g) => [g.key, g.rows.map((t) => t.id)])).toEqual([
      ["needs", ["ask1"]],
      ["failed", ["fail1"]],
      ["running", ["run1", "run2"]],
      ["done", ["done1", "done2"]],
    ]);
    expect(drawnOrder({ ...base, sections, ledger: true, folders: null }).map((t) => t.id)).toEqual([
      "ask1", "fail1", "run1", "run2", "done1", "done2",
    ]);
  });

  it("follows the folders, then the stray list, and skips a collapsed folder", () => {
    const a = thread("a1", { position: 0 }, { project_id: "pa" });
    const b = thread("b1", { position: 1 }, { project_id: "pb" });
    const b2 = thread("b2", { position: 2 }, { project_id: "pb" });
    const lost = thread("lost", { position: 3 }, { project_id: "gone" });
    const pinned = thread("pin", { pinned_at: "2026-10-30T00:00:00Z" });
    const busy = thread("busy", { position: 4 }, { ...running, project_id: "pa" });
    const sections = arrangeThreads([a, b, b2, lost, pinned, busy], now);
    const folders = foldersOf([project("pa"), project("pb")], [a, b, b2], null, "created_at", "updated_at");
    const names = (rows: Thread[]) => rows.map((t) => t.id);
    const input = { ...base, sections, ledger: false, folders, strays: [lost] };
    const order = names(drawnOrder(input));
    // The Working shelf is drawn above the folders, and its threads are in no folder.
    expect(order.slice(0, 2)).toEqual(["busy", "pin"]);
    expect(order.slice(2)).toEqual([...folders.flatMap((f) => names(f.threads)), "lost"]);
    const collapsed = names(drawnOrder({ ...input, folderOpen: (f) => f.key !== "pa" }));
    expect(collapsed).not.toContain("a1");
    expect(collapsed).toContain("b1");
  });

  it("leaves a closed Working shelf out of the folder view, and a bare project draws no threads", () => {
    const busy = thread("busy", { position: 0 }, { ...running, project_id: "pa" });
    const sections = arrangeThreads([busy, thread("a1", { position: 1 }, { project_id: "pa" })], now);
    const folders = foldersOf([project("pa"), project("empty")], sections.active, null, "created_at", "updated_at");
    const closed = { ...base, sections, ledger: false, folders, groupOpen: (id: string) => id !== "working" };
    expect(drawnOrder(closed).map((t) => t.id)).toEqual(["a1"]);
    expect(drawnOrder({ ...closed, groupOpen: open }).map((t) => t.id)).toEqual(["busy", "a1"]);
    expect(folders.find((folder) => folder.project.id === "empty")?.threads).toEqual([]);
  });

  it("includes an open Settled group only when it is shown", () => {
    const settled = thread("old", { settled_at: "2026-10-29T00:00:00Z" });
    const sections = arrangeThreads([thread("x"), settled], now);
    const input = { ...base, sections, ledger: false, folders: null, settled: sections.settled };
    expect(drawnOrder({ ...input, groupOpen: (id) => id !== "settled" }).map((t) => t.id)).toEqual(["x"]);
    expect(drawnOrder(input).map((t) => t.id)).toEqual(["x", "old"]);
  });
});
