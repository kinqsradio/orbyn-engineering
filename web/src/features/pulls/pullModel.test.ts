import { describe, expect, it } from "vitest";
import type { PullListEntry } from "../../api/types";
import { noFilters, parseSearch, visiblePulls } from "./pullModel";

const entry = (number: number, over: Partial<PullListEntry["pull"]> = {}, project = "p"): PullListEntry => ({
  project_id: project,
  pull: {
    number,
    title: `PR ${number}`,
    url: "",
    state: "open",
    head: "h",
    base: "main",
    author: null,
    draft: false,
    updated_at: null,
    labels: [],
    review_state: null,
    checks_state: null,
    ...over,
  },
});

describe("pull list", () => {
  it("takes label: words out of the search", () => {
    expect(parseSearch("fix label:Bug login")).toEqual({ query: "fix login", labels: ["bug"] });
  });

  it("filters and sorts on what the forge reports", () => {
    const list = [entry(1, { draft: true }), entry(2, { checks_state: "failing" }), entry(3, { labels: ["Bug"] }, "q")];
    expect(visiblePulls(list, { ...noFilters, draft: "hide" }, [], "newest").map((e) => e.pull.number)).toEqual([3, 2]);
    expect(visiblePulls(list, { ...noFilters, checks: "failing" }, [], "newest").map((e) => e.pull.number)).toEqual([2]);
    expect(visiblePulls(list, noFilters, ["bug"], "oldest").map((e) => e.pull.number)).toEqual([3]);
    expect(visiblePulls(list, { ...noFilters, project: "q" }, [], "oldest")).toHaveLength(1);
  });
});
