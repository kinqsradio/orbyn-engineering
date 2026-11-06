import { describe, expect, it } from "vitest";
import type { EngineUsage } from "../../api/types";
import { axisTicks, costBreakdown, formatTokens, periodDates, usageTotals } from "./usageModel";

const engine = (over: Partial<EngineUsage>): EngineUsage => ({
  engine: "codex",
  status: "scanned",
  files_scanned: 1,
  files_skipped: 0,
  models: [],
  days: [],
  ...over,
});

const model = (name: string, tokens: number, cost: number | null) => ({
  model: name,
  input_tokens: tokens,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  estimated_cost: cost,
  cost_split: cost === null ? null : { input: cost, output: 0, cache_read: 0, cache_write: 0 },
  tiers: [{ tier: "standard", tokens, estimated_cost: cost }],
  unpriced_tokens: cost === null ? tokens : 0,
});

describe("usage totals", () => {
  it("adds what is priced and marks the rest unknown, never zero", () => {
    const totals = usageTotals(
      [
        engine({ models: [model("a", 100, 2), model("b", 50, null)] }),
        engine({ engine: "claude", models: [model("c", 10, null)] }),
        engine({ engine: "empty", status: "no_history" }),
      ],
      7,
      new Date("2026-10-31T12:00:00Z"),
    );
    expect(totals.tokens).toBe(160);
    expect(totals.cost).toBe(2);
    expect(totals.unpriced).toBe(true);
    expect(totals.engines.map((entry) => entry.engine)).toEqual(["codex", "claude"]);
    expect(totals.engines[1]?.cost).toBeNull();
  });

  it("has no cost at all when nothing is priced", () => {
    const totals = usageTotals([engine({ models: [model("a", 1, null)] })], 1, new Date());
    expect(totals.cost).toBeNull();
  });
});

describe("usage formatting", () => {
  it("shortens tokens the way the reference does", () => {
    expect(formatTokens(5_790_000_000)).toBe("5.79B");
    expect(formatTokens(474_000_000)).toBe("474M");
    expect(formatTokens(79_200_000)).toBe("79.2M");
    expect(formatTokens(950)).toBe("950");
  });

  it("lists every day of a period, oldest first", () => {
    expect(periodDates(3, new Date("2026-11-01T12:00:00Z"))).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });

  it("steps the axis past the largest value", () => {
    expect(axisTicks(1_800)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(axisTicks(0)).toEqual([0]);
  });
});

describe("cost split", () => {
  it("adds token-type costs and keeps an unpriced tier unknown", () => {
    const fast = {
      ...model("f", 30, 6),
      cost_split: { input: 4, output: 2, cache_read: 0, cache_write: 0 },
      tiers: [
        { tier: "standard", tokens: 10, estimated_cost: 1 },
        { tier: "fast", tokens: 20, estimated_cost: 5 },
        { tier: "priority", tokens: 7, estimated_cost: null },
      ],
      unpriced_tokens: 7,
    };
    const { split, tiers } = costBreakdown([model("a", 100, 2), fast]);
    expect(split).toEqual({ input: 6, output: 2, cache_read: 0, cache_write: 0 });
    expect(tiers).toEqual([
      { tier: "standard", tokens: 110, cost: 3, unpricedTokens: 0 },
      { tier: "fast", tokens: 20, cost: 5, unpricedTokens: 0 },
      { tier: "priority", tokens: 7, cost: null, unpricedTokens: 7 },
    ]);
    expect(costBreakdown([model("b", 5, null)]).split).toBeNull();
  });
});
