import { describe, expect, it } from "vitest";
import { navigate, parseRoute, routeHref, type Route } from "./route";

describe("routes", () => {
  it.each<Route>([
    { name: "home" },
    { name: "thread", id: "t/1 x" },
    { name: "new", projectId: null },
    { name: "new", projectId: "p1" },
    { name: "trust", projectId: "p", threadId: null },
    { name: "trust", projectId: "p", threadId: "t" },
    { name: "settings", section: null },
    { name: "settings", section: "projects" },
    { name: "settings", section: "threads", machine: "remote/missing" },
    { name: "settings", section: "worktrees", selection: { kind: "project_group", group_key: "group:/one?x" } },
    { name: "settings", section: "threads", selection: { kind: "checkout", group_key: "group:/one", project_id: "id/2" } },
  ])("round-trips %j", (route) => {
    expect(parseRoute(routeHref(route))).toEqual(route);
  });

  it("preserves explicit malformed IDs and selection across settings navigation", () => {
    expect(parseRoute("#/settings/worktrees?project=g?bad")).toEqual({ name: "settings", section: "worktrees", selection: { kind: "project_group", group_key: "g?bad" } });
    expect(parseRoute("#/settings/worktrees?checkout=gone")).toEqual({ name: "settings", section: "worktrees", selection: { kind: "checkout", group_key: "", project_id: "gone" } });
    expect(parseRoute("#/settings/worktrees?project=")).toEqual({ name: "settings", section: "worktrees", selection: { kind: "project_group", group_key: "" } });
    window.location.hash = "#/settings/worktrees?project=g&checkout=p";
    navigate({ name: "settings", section: "threads" });
    expect(window.location.hash).toBe("#/settings/threads?project=g&checkout=p");
    window.location.hash = "#/settings/worktrees?machine=missing&project=g";
    navigate({ name: "settings", section: "threads" });
    expect(parseRoute(window.location.hash)).toEqual({ name: "settings", section: "threads", machine: "missing", selection: { kind: "project_group", group_key: "g" } });
    navigate({ name: "settings", section: "threads", selection: undefined });
    expect(window.location.hash).toBe("#/settings/threads");
  });

  it("treats unknown hashes as home and unknown sections as none", () => {
    expect(parseRoute("#/nowhere")).toEqual({ name: "home" });
    expect(parseRoute("#/settings/nope")).toEqual({ name: "settings", section: null });
  });
});
