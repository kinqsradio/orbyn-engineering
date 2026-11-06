import type { EngineUsage, ModelUsage } from "../../api/types";
import type { TokenCosts } from "../../generated/TokenCosts";

export type UsageMetric = "cost" | "tokens" | "limits";
export const USAGE_PERIODS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;
export type UsageDays = (typeof USAGE_PERIODS)[number]["days"];

export const modelTokens = (model: ModelUsage) =>
  model.input_tokens + model.output_tokens + model.cache_read_tokens + model.cache_write_tokens;

/** Cached input as a share of all input, or null with no input. */
export function cacheHit(model: ModelUsage): number | null {
  const input = model.input_tokens + model.cache_read_tokens + model.cache_write_tokens;
  return input > 0 ? model.cache_read_tokens / input : null;
}

/** Dollars per million priced tokens, or null when nothing is priced. */
export function costPerMillion(model: ModelUsage): number | null {
  const priced = modelTokens(model) - model.unpriced_tokens;
  return model.estimated_cost === null || priced <= 0 ? null : (model.estimated_cost / priced) * 1e6;
}

/** One value per period day, zero where the model was idle. */
export function modelTrend(model: ModelUsage, dates: readonly string[]): number[] {
  const byDay = new Map(model.days.map((day) => [day.date, day.tokens]));
  return dates.map((date) => byDay.get(date) ?? 0);
}

export interface ModelRow extends ModelUsage {
  engine: string;
  tokens: number;
}

export interface EngineTotals {
  engine: string;
  tokens: number;
  /** Null when no model of this engine has a price. */
  cost: number | null;
  unpriced: boolean;
  models: ModelRow[];
  daily: Map<string, number>;
  /** The priced part of each day; a day with nothing priced is absent. */
  dailyCost: Map<string, number>;
}

export const TIER_LABELS: Record<string, string> = {
  standard: "Standard",
  fast: "Fast",
  priority: "Priority",
  batch: "Batch",
  flex: "Flex",
  other: "Other",
};

export interface TierTotal {
  tier: string;
  tokens: number;
  /** Null when no model in this tier has a price for it. */
  cost: number | null;
  unpricedTokens: number;
}

const zeroCosts = (): TokenCosts => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

/** Sums the priced part by token type and the tiers history records. */
export function costBreakdown(models: readonly ModelUsage[]): { split: TokenCosts | null; tiers: TierTotal[] } {
  let split: TokenCosts | null = null;
  const tiers = new Map<string, TierTotal>();
  for (const model of models) {
    if (model.cost_split) {
      split ??= zeroCosts();
      split.input += model.cost_split.input;
      split.output += model.cost_split.output;
      split.cache_read += model.cost_split.cache_read;
      split.cache_write += model.cost_split.cache_write;
    }
    for (const tier of model.tiers) {
      const known = tiers.get(tier.tier) ?? { tier: tier.tier, tokens: 0, cost: null, unpricedTokens: 0 };
      known.tokens += tier.tokens;
      if (tier.estimated_cost === null) known.unpricedTokens += tier.tokens;
      else known.cost = (known.cost ?? 0) + tier.estimated_cost;
      tiers.set(tier.tier, known);
    }
  }
  return { split, tiers: [...tiers.values()].sort((a, b) => b.tokens - a.tokens) };
}

export interface UsageTotals {
  engines: EngineTotals[];
  tokens: number;
  cost: number | null;
  unpriced: boolean;
  input: number;
  output: number;
  cached: number;
  cacheWrites: number;
  /** Every day in the period, oldest first. */
  dates: string[];
  /** The priced part of the cost by token type, or null when nothing is priced. */
  costSplit: TokenCosts | null;
  tiers: TierTotal[];
}

export function periodDates(days: number, today: Date): string[] {
  const dates: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

export function usageTotals(reports: readonly EngineUsage[], days: number, today: Date): UsageTotals {
  const engines = reports
    .filter((report) => report.status !== "no_history")
    .map((report): EngineTotals => {
      const models = report.models
        .map((model) => ({ ...model, engine: report.engine, tokens: modelTokens(model) }))
        .sort((a, b) => b.tokens - a.tokens);
      const priced = models.filter((model) => model.estimated_cost !== null);
      return {
        engine: report.engine,
        tokens: models.reduce((sum, model) => sum + model.tokens, 0),
        cost: priced.length > 0 ? priced.reduce((sum, model) => sum + (model.estimated_cost ?? 0), 0) : null,
        unpriced: priced.length < models.length || models.some((model) => model.unpriced_tokens > 0),
        models,
        daily: new Map(report.days.map((day) => [day.date, day.tokens])),
        dailyCost: new Map(
          report.days.flatMap((day) => (day.estimated_cost === null ? [] : [[day.date, day.estimated_cost] as const])),
        ),
      };
    })
    .filter((engine) => engine.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const models = engines.flatMap((engine) => engine.models);
  const costs = engines.flatMap((engine) => (engine.cost === null ? [] : [engine.cost]));
  const breakdown = costBreakdown(models);
  return {
    engines,
    tokens: engines.reduce((sum, engine) => sum + engine.tokens, 0),
    cost: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    unpriced: engines.some((engine) => engine.unpriced),
    input: models.reduce((sum, model) => sum + model.input_tokens, 0),
    output: models.reduce((sum, model) => sum + model.output_tokens, 0),
    cached: models.reduce((sum, model) => sum + model.cache_read_tokens, 0),
    cacheWrites: models.reduce((sum, model) => sum + model.cache_write_tokens, 0),
    dates: periodDates(days, today),
    costSplit: breakdown.split,
    tiers: breakdown.tiers,
  };
}

export function formatTokens(value: number): string {
  const steps = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const;
  for (const [size, unit] of steps) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toPrecision(3))}${unit}`;
    }
  }
  return String(Math.round(value));
}

export const formatUsd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const formatPercent = (share: number) => `${(share * 100).toFixed(1)}%`;

/** Rounded axis steps above the largest value. */
export function axisTicks(max: number): number[] {
  if (max <= 0) return [0];
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((unit) => unit * power).find((value) => value >= rough) ?? rough;
  const ticks: number[] = [];
  for (let value = 0; value < max + step; value += step) ticks.push(value);
  return ticks;
}

export interface Share {
  engine: string;
  value: number;
  share: number;
}

/** Each engine's part of the tokens, or of the priced cost. Unpriced engines drop out of a cost share. */
export function engineShares(engines: readonly EngineTotals[], metric: "cost" | "tokens"): Share[] {
  const values = engines.map((engine) => ({
    engine: engine.engine,
    value: metric === "cost" ? (engine.cost ?? 0) : engine.tokens,
  }));
  const total = values.reduce((sum, entry) => sum + entry.value, 0);
  return values.filter((entry) => entry.value > 0).map((entry) => ({ ...entry, share: total > 0 ? entry.value / total : 0 }));
}
