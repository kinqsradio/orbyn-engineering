import { describe, expect, it } from "vitest";
import { parseRoute, routeHref, type Route } from "./route";

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
  ])("round-trips %j", (route) => {
    expect(parseRoute(routeHref(route))).toEqual(route);
  });

  it("treats unknown hashes as home and unknown sections as none", () => {
    expect(parseRoute("#/nowhere")).toEqual({ name: "home" });
    expect(parseRoute("#/settings/nope")).toEqual({ name: "settings", section: null });
  });
});
