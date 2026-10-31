import type { EngineUsage, ModelUsage } from "../../api/types";

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
        unpriced: priced.length < models.length,
        models,
        daily: new Map(report.days.map((day) => [day.date, day.tokens])),
      };
    })
    .filter((engine) => engine.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const models = engines.flatMap((engine) => engine.models);
  const costs = engines.flatMap((engine) => (engine.cost === null ? [] : [engine.cost]));
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
