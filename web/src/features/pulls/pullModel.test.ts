import { describe, expect, it } from "vitest";
import type { PullListEntry } from "../../api/types";
import { activeChips, checksOf, noFilters, parseSearch, statesToAsk, visiblePulls, type PullSort } from "./pullModel";

const newest: PullSort = { by: "created", dir: "newest" };
const oldest: PullSort = { by: "created", dir: "oldest" };

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
    const numbers = (filters = noFilters, labels: string[] = [], sort = newest) => visiblePulls(list, filters, labels, sort).map((e) => e.pull.number);
    expect(numbers({ ...noFilters, draft: "hide" })).toEqual([3, 2]);
    expect(numbers({ ...noFilters, checks: ["failing"] })).toEqual([2]);
    expect(numbers({ ...noFilters, labels: ["bug"] })).toEqual([3]);
    expect(numbers(noFilters, ["bug"], oldest)).toEqual([3]);
    expect(numbers({ ...noFilters, project: "q" }, [], oldest)).toEqual([3]);
    expect(numbers(noFilters, [], oldest)).toEqual([1, 2, 3]);
  });

  it("keeps a pull request that matches any chosen review or check", () => {
    const list = [entry(1, { review_state: "approved" }), entry(2, { review_state: "changes_requested", checks_state: "pending" }), entry(3)];
    const numbers = (filters: Parameters<typeof visiblePulls>[1]) => visiblePulls(list, filters, [], newest).map((e) => e.pull.number);
    expect(numbers({ ...noFilters, review: ["approved", "changes_requested"] })).toEqual([2, 1]);
    expect(numbers({ ...noFilters, checks: ["running"] })).toEqual([2]);
  });

  it("limits Me to the viewer's login", () => {
    const list = [entry(1, { author: "ada" }), entry(2, { author: "grace" })];
    expect(visiblePulls(list, { ...noFilters, me: true }, [], newest, "grace").map((e) => e.pull.number)).toEqual([2]);
  });

  it("asks the service for each chosen state, or all of them at once", () => {
    expect(statesToAsk(["open", "merged"])).toEqual(["open", "merged"]);
    expect(statesToAsk(["open", "closed", "merged"])).toEqual(["all"]);
  });

  it("never counts the defaults as active filters", () => {
    expect(activeChips(noFilters)).toEqual([]);
    expect(activeChips({ ...noFilters, review: ["approved"], checks: ["failing"] }).map((chip) => chip.label)).toEqual([
      "Review: approved",
      "Checks: failing",
    ]);
  });

  it.each([
    ["pass", "pass"],
    ["passing", "pass"],
    ["fail", "fail"],
    ["failing", "fail"],
    ["pending", "pending"],
    ["none", "none"],
    [null, "none"],
    ["something new", "none"],
  ] as const)("reads check state %j as %s", (state, word) => {
    expect(checksOf(state)).toBe(word);
  });
});
