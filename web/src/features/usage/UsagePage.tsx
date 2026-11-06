import { ChevronDown, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useCommand } from "../../app/shortcuts";
import type { EngineLimits, LimitsOverview, ModelUsage, UsageReport } from "../../api/types";
import { readJson, writeJson } from "../../lib/storage";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, Field, IconButton } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Menu } from "../../ui/Menu";
import { ErrorState, Loading } from "../../ui/states";
import { UsageChart } from "./UsageChart";
import { useUsageReport } from "./useUsageReport";
import {
  cacheHit,
  costPerMillion,
  engineShares,
  formatPercent,
  formatTokens,
  formatUsd,
  modelTrend,
  TIER_LABELS,
  USAGE_PERIODS,
  usageTotals,
  type UsageDays,
  type UsageMetric,
} from "./usageModel";

const PREFS_KEY = "orbyn.usage.v1";
const CHART_COLORS = ["var(--color-text)", "var(--color-warn)", "var(--color-info)", "var(--color-success)"];

const METRICS: { id: UsageMetric; label: string }[] = [
  { id: "cost", label: "Cost" },
  { id: "tokens", label: "Tokens" },
  { id: "limits", label: "Limits" },
];

function Segment<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: NoInfer<T>; label: string }[];
  onChange(value: NoInfer<T>): void;
}) {
  return (
    <div className="segment" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** A model's daily tokens across the period, scaled to its own busiest day. */
function Sparkline({ values, label }: { values: readonly number[]; label: string }) {
  const width = 72;
  const height = 18;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((value, at) => `${(at * step).toFixed(1)},${(height - 1 - (value / max) * (height - 2)).toFixed(1)}`);
  return (
    <svg className="usage-spark" width={width} height={height} role="img" aria-label={label}>
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  );
}

const perMillion = (model: ModelUsage) => {
  const rate = costPerMillion(model);
  return rate === null ? "—" : `${formatUsd(rate)}/M`;
};

const hitText = (model: ModelUsage) => {
  const hit = cacheHit(model);
  return hit === null ? "—" : formatPercent(hit);
};

/** Each provider's part of the period, in one bar. */
function ShareBar({
  engines,
  metric,
  colorOf,
  nameOf,
}: {
  engines: Parameters<typeof engineShares>[0];
  metric: "cost" | "tokens";
  colorOf(engine: string): string;
  nameOf(engine: string): string;
}) {
  const shares = engineShares(engines, metric);
  if (shares.length === 0) return null;
  const label = metric === "cost" ? "Share of priced cost" : "Share of tokens";
  return (
    <div className="usage-sharebar" role="group" aria-label={label}>
      {shares.map((entry) => (
        <span
          key={entry.engine}
          title={`${nameOf(entry.engine)} ${formatPercent(entry.share)}`}
          aria-label={`${nameOf(entry.engine)} ${formatPercent(entry.share)}`}
          style={{ width: `${entry.share * 100}%`, background: colorOf(entry.engine) }}
        />
      ))}
    </div>
  );
}

/** What the last local scan read, so a short or empty period can be explained. */
function ScanStatus({ report, nameOf }: { report: UsageReport; nameOf(engine: string): string }) {
  const at = new Date(report.scanned_at);
  const when = Number.isNaN(at.getTime()) ? report.scanned_at : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const parts = report.engines.map((engine) => {
    if (engine.status === "no_history") return `${nameOf(engine.engine)}: no local history`;
    const skipped = engine.files_skipped > 0 ? `, ${engine.files_skipped} unreadable` : "";
    return `${nameOf(engine.engine)}: ${engine.files_scanned} ${engine.files_scanned === 1 ? "file" : "files"}${skipped}`;
  });
  return (
    <p className="usage-note usage-scan" aria-label="Scan status">
      Local history scanned at {when}. {parts.join(" · ")}
    </p>
  );
}

function resetsIn(iso: string): string {
  const left = new Date(iso).getTime() - Date.now();
  if (left <= 0) return "soon";
  const minutes = Math.round(left / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

function LimitRow({ label, used, resets }: { label: string; used: number; resets: string | null }) {
  const left = Math.max(0, Math.round(100 - used));
  return (
    <div className="limit-row">
      <div className="limit-head">
        <span>{label}</span>
        <strong>{left}% left</strong>
      </div>
      <div
        className="limit-meter"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
      >
        <span style={{ width: `${left}%` }} data-low={left < 15 || undefined} />
      </div>
      {resets ? <span className="limit-reset">Resets {resetsIn(resets)}</span> : null}
    </div>
  );
}

function LimitsView({ data, nameOf }: { data: LimitsOverview; nameOf(engine: string): string }) {
  const empty = data.pooled.length === 0 && data.engines.length === 0;
  return (
    <div className="usage-body">
      {data.unavailable.map((entry) => (
        <p key={entry.engine} className="usage-note">
          {nameOf(entry.engine)}: {entry.reason}
        </p>
      ))}
      {empty ? <p className="usage-note">No engine reports limits.</p> : null}
      {data.pooled.length > 0 ? (
        <section className="usage-section">
          <h2>Pooled</h2>
          <div className="limit-grid">
            {data.pooled.map((window) => (
              <LimitRow
                key={window.label}
                label={window.label}
                used={window.used_percent}
                resets={window.resets_at}
              />
            ))}
          </div>
        </section>
      ) : null}
      {data.engines.map((engine: EngineLimits) => (
        <section key={engine.engine} className="usage-section">
          <h2>
            {nameOf(engine.engine)}
            {engine.plan ? <span className="usage-plan">{engine.plan}</span> : null}
          </h2>
          <div className="limit-grid">
            {engine.windows.map((window) => (
              <LimitRow
                key={window.id}
                label={window.label}
                used={window.used_percent}
                resets={window.resets_at}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function UsageView({
  report,
  metric,
  days,
  only,
  nameOf,
  onSaved,
}: {
  report: UsageReport;
  metric: "cost" | "tokens";
  days: UsageDays;
  only: string | null;
  nameOf(engine: string): string;
  /** A price or alias changed, so the report does too. */
  onSaved(): void;
}) {
  const totals = useMemo(
    () => usageTotals(report.engines.filter((engine) => !only || engine.engine === only), days, new Date()),
    [report, days, only],
  );
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const [pricing, setPricing] = useState<string | null>(null);
  const colorOf = (engine: string) => {
    const at = report.engines.findIndex((entry) => entry.engine === engine);
    return CHART_COLORS[at % CHART_COLORS.length] ?? "var(--color-text)";
  };
  if (totals.engines.length === 0) {
    return (
      <div className="usage-body">
        <p className="usage-note">No usage in this period.</p>
      </div>
    );
  }
  const cost = (value: number | null) => (value === null ? "Unpriced" : formatUsd(value));
  const models = totals.engines.flatMap((engine) => engine.models).sort((a, b) => b.tokens - a.tokens);
  const dated = [...totals.dates].reverse().filter((date) => totals.engines.some((engine) => engine.daily.has(date)));
  return (
    <div className="usage-body">
      <section className="usage-hero">
        <div className="usage-summary">
          <div className="usage-total">
            <strong>{metric === "cost" ? cost(totals.cost) : formatTokens(totals.tokens)}</strong>
            {metric === "cost" ? (
              <span>
                API estimate
                {totals.unpriced && totals.cost !== null ? ", some usage is unpriced" : ""}
              </span>
            ) : null}
          </div>
          {totals.engines.length > 1 ? (
            <ShareBar engines={totals.engines} metric={metric} colorOf={colorOf} nameOf={nameOf} />
          ) : null}
          {totals.engines.map((engine) => {
            const share = totals.tokens > 0 ? engine.tokens / totals.tokens : 0;
            return (
              <div key={engine.engine} className="usage-engine">
                <div>
                  <span>
                    <span className="usage-dot" style={{ background: colorOf(engine.engine) }} />
                    {nameOf(engine.engine)}
                  </span>
                  <strong>{metric === "cost" ? cost(engine.cost) : formatTokens(engine.tokens)}</strong>
                </div>
                <span className="usage-share">
                  {metric === "cost"
                    ? `${formatTokens(engine.tokens)} tokens`
                    : `${formatPercent(share)} of tokens · ${cost(engine.cost)}`}
                </span>
              </div>
            );
          })}
        </div>
        {days > 1 && (metric === "tokens" || totals.cost !== null) ? (
          <div className="usage-plot">
            <h2>{metric === "cost" ? "Daily estimated cost" : "Daily processed tokens"}</h2>
            <UsageChart
              engines={totals.engines}
              dates={totals.dates}
              colorOf={colorOf}
              nameOf={nameOf}
              metric={metric}
            />
          </div>
        ) : null}
      </section>
      <section className="usage-section">
        <h2>Totals</h2>
        <div className="usage-stats">
          <Stat label="Processed tokens" value={formatTokens(totals.tokens)} />
          <Stat label="Cached input" value={formatTokens(totals.cached)} />
          <Stat label="Uncached input" value={formatTokens(totals.input)} />
          <Stat label="Output" value={formatTokens(totals.output)} />
        </div>
      </section>
      {metric === "cost" ? (
        <section className="usage-section" aria-label="Cost split">
          <h2>Cost by token type</h2>
          {totals.costSplit ? (
            <div className="usage-stats">
              <Stat label="Uncached input" value={formatUsd(totals.costSplit.input)} />
              <Stat label="Output" value={formatUsd(totals.costSplit.output)} />
              <Stat label="Cached input" value={formatUsd(totals.costSplit.cache_read)} />
              <Stat label="Cache write" value={formatUsd(totals.costSplit.cache_write)} />
            </div>
          ) : (
            <p className="usage-note">No model in this period has a price.</p>
          )}
          <h2>Cost by tier</h2>
          <div className="usage-stats">
            {totals.tiers.map((tier) => (
              <Stat
                key={tier.tier}
                label={`${TIER_LABELS[tier.tier] ?? tier.tier} · ${formatTokens(tier.tokens)} tokens`}
                value={
                  tier.cost === null
                    ? "Unpriced"
                    : `${formatUsd(tier.cost)}${tier.unpricedTokens > 0 ? ` + ${formatTokens(tier.unpricedTokens)} unpriced` : ""}`
                }
              />
            ))}
          </div>
        </section>
      ) : null}
      <section className="usage-section">
        <div className="usage-section-head">
          <h2>Breakdown</h2>
          <Segment
            label="Usage breakdown"
            value={breakdown}
            options={[
              { value: "model", label: "Model" },
              { value: "time", label: "Day" },
            ]}
            onChange={setBreakdown}
          />
        </div>
        <div className="usage-table">
          {breakdown === "model" ? (
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Cost</th>
                  <th>Per million</th>
                  <th>Cache hit</th>
                  <th>Trend</th>
                  <th>Share</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={`${model.engine}:${model.model}`}>
                    <td>
                      <button type="button" className="text-action" aria-label={`Set price for ${model.model}`} onClick={() => setPricing(model.model)}>
                        {model.model}
                      </button>
                    </td>
                    <td>{cost(model.estimated_cost)}</td>
                    <td>{perMillion(model)}</td>
                    <td>{hitText(model)}</td>
                    <td>
                      <Sparkline values={modelTrend(model, totals.dates)} label={`${model.model} daily tokens`} />
                    </td>
                    <td>{formatPercent(totals.tokens > 0 ? model.tokens / totals.tokens : 0)}</td>
                    <td>{formatTokens(model.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  {totals.engines.map((engine) => (
                    <th key={engine.engine}>{nameOf(engine.engine)}</th>
                  ))}
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {dated.map((date) => (
                  <tr key={date}>
                    <td>{date}</td>
                    {totals.engines.map((engine) => (
                      <td key={engine.engine}>{formatTokens(engine.daily.get(date) ?? 0)}</td>
                    ))}
                    <td>
                      {formatTokens(totals.engines.reduce((sum, engine) => sum + (engine.daily.get(date) ?? 0), 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      {pricing ? <ModelPriceDialog model={pricing} onClose={() => setPricing(null)} onSaved={onSaved} /> : null}
    </div>
  );
}

const RATES = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cache_read", label: "Cached input" },
  { key: "cache_write", label: "Cache write" },
] as const;

const PRICE_TIERS = ["standard", "fast", "priority", "batch", "flex", "other"] as const;
const sameTier = (tier: string | undefined, wanted: string) => (tier ?? "standard") === wanted;

/** A model's rates per million tokens for one tier, or another model it counts as. */
function ModelPriceDialog({ model, onClose, onSaved }: { model: string; onClose(): void; onSaved(): void }) {
  const settings = useAsync("usage-settings", (signal) => api.settings(signal));
  const [tier, setTier] = useState<string>("standard");
  const current = settings.data?.model_prices?.find((price) => price.model === model && sameTier(price.tier, tier));
  const alias = settings.data?.model_aliases?.find((entry) => entry.model === model);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [countsAs, setCountsAs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = (key: (typeof RATES)[number]["key"]) => rates[key] ?? (current ? String(current[key]) : "");
  const save = async () => {
    if (!settings.data) return;
    setBusy(true);
    setError(null);
    const target = (countsAs ?? alias?.counts_as ?? "").trim();
    const priced = RATES.some((rate) => shown(rate.key) !== "");
    const number = (key: (typeof RATES)[number]["key"]) => Number(shown(key));
    try {
      await api.putSettings({
        ...settings.data,
        model_prices: [
          ...(settings.data.model_prices ?? []).filter((price) => price.model !== model || !sameTier(price.tier, tier)),
          ...(priced
            ? [{
                model,
                input: number("input"),
                output: number("output"),
                cache_read: number("cache_read"),
                cache_write: number("cache_write"),
                ...(tier === "standard" ? {} : { tier }),
              }]
            : []),
        ],
        model_aliases: [
          ...(settings.data.model_aliases ?? []).filter((entry) => entry.model !== model),
          ...(target ? [{ model, counts_as: target }] : []),
        ],
      });
      onSaved();
      onClose();
    } catch (failure) {
      setError(`Your changes are kept. ${toFailure(failure).message}`);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Price for ${model}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" busy={busy} disabled={!settings.data} onClick={() => void save()}>
            Save price
          </Button>
        </>
      }
    >
      <p>Dollars per million tokens. Another tier never borrows the standard rate.</p>
      <Field label="Tier">
        {(props) => (
          <select
            {...props}
            value={tier}
            onChange={(event) => {
              setTier(event.target.value);
              setRates({});
            }}
          >
            {PRICE_TIERS.map((entry) => (
              <option key={entry} value={entry}>
                {TIER_LABELS[entry]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {RATES.map((rate) => (
        <Field key={rate.key} label={rate.label}>
          {(props) => (
            <input
              {...props}
              type="number"
              min="0"
              step="any"
              value={shown(rate.key)}
              onChange={(event) => setRates({ ...rates, [rate.key]: event.target.value })}
            />
          )}
        </Field>
      ))}
      <Field label="Counts as" hint="Another model whose price this one follows.">
        {(props) => <input {...props} value={countsAs ?? alias?.counts_as ?? ""} onChange={(event) => setCountsAs(event.target.value)} />}
      </Field>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Usage floats over the workspace, like Settings. */
export function UsagePage({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const saved = readJson<{ days?: UsageDays; metric?: UsageMetric }>(PREFS_KEY);
  const [days, setDays] = useState<UsageDays>(saved?.days ?? 30);
  const [metric, setMetric] = useState<UsageMetric>(saved?.metric ?? "tokens");
  const [only, setOnly] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const engines = useWorkspace((state) => state.engines.data);
  const pushToast = useUi((state) => state.pushToast);
  const nameOf = (id: string) => engines?.find((engine) => engine.id === id)?.name ?? id;

  const usage = useUsageReport(days);
  const limits = useAsync(`limits:${metric === "limits"}:${nonce}`, (signal) =>
    metric === "limits" ? api.limits(false, signal) : Promise.resolve(null),
  );

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => writeJson(PREFS_KEY, { days, metric }), [days, metric]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return;
      const next = { c: "cost", t: "tokens", l: "limits" }[event.key.toLowerCase()] as UsageMetric | undefined;
      if (next) setMetric(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useCommand("usage.period.day", () => setDays(1));
  useCommand("usage.period.week", () => setDays(7));
  useCommand("usage.period.month", () => setDays(30));
  useCommand("usage.period.quarter", () => setDays(90));

  const refresh = async () => {
    if (metric !== "limits") {
      await usage.refresh();
      return;
    }
    setRefreshing(true);
    try {
      await api.limits(true);
      setNonce(nonce + 1);
    } catch (failure) {
      pushToast(`Couldn't refresh. ${toFailure(failure).message}`);
    } finally {
      setRefreshing(false);
    }
  };

  const providers = usage.data?.engines ?? [];
  const pending = metric === "limits" ? refreshing : usage.pending;

  return (
    <dialog
      ref={ref}
      className="usage-panel"
      aria-label="Usage"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="usage-head">
        <div className="usage-crumbs">
          <h1>Usage</h1>
          <span className="crumb-slash" aria-hidden>
            /
          </span>
          <button
            type="button"
            className="usage-picker"
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            {only ? nameOf(only) : "All providers"}
            <ChevronDown size={14} aria-hidden />
          </button>
        </div>
        <div className="usage-controls">
          {metric === "limits" ? null : (
            <Segment
              label="Usage period"
              value={days}
              options={USAGE_PERIODS.map((period) => ({ value: period.days, label: period.label }))}
              onChange={setDays}
            />
          )}
          <Segment
            label="Usage metric"
            value={metric}
            options={METRICS.map((entry) => ({ value: entry.id, label: entry.label }))}
            onChange={setMetric}
          />
          <IconButton
            label={metric === "limits" ? "Refresh limits" : "Refresh usage"}
            disabled={pending}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={pending ? "spin" : undefined} aria-hidden />
          </IconButton>
          <IconButton label="Close usage" onClick={onClose}>
            <X size={16} aria-hidden />
          </IconButton>
        </div>
      </header>
      <div className="usage-scroll">
        {metric === "limits" ? (
          limits.status === "error" ? (
            <ErrorState title="Couldn't load limits" failure={limits.error} onRetry={limits.reload} />
          ) : limits.status === "ready" && limits.data ? (
            <LimitsView data={limits.data} nameOf={nameOf} />
          ) : (
            <div className="usage-body">
              <Loading label="Loading limits" rows={3} />
            </div>
          )
        ) : (
          <div className="usage-history" data-refreshing={usage.pending && usage.data ? true : undefined}>
            {usage.pending && usage.data ? <p className="usage-refresh-status" role="status">Refreshing usage…</p> : null}
            {usage.error ? (
              <ErrorState
                title={usage.data ? "Couldn't refresh usage" : "Couldn't load usage"}
                failure={usage.error}
                onRetry={usage.data ? usage.refresh : usage.reload}
              />
            ) : null}
            <div aria-busy={usage.pending}>
              {usage.data ? (
                <>
                  <UsageView report={usage.data} metric={metric} days={days} only={only} nameOf={nameOf} onSaved={() => void usage.reload()} />
                  <ScanStatus report={usage.data} nameOf={nameOf} />
                </>
              ) : usage.pending ? (
                <div className="usage-body"><Loading label="Loading usage" rows={4} /></div>
              ) : null}
            </div>
          </div>
        )}
      </div>
      {menu ? (
        <Menu
          {...menu}
          label="Providers"
          onClose={() => setMenu(null)}
          items={[
            { label: "All providers", selected: only === null, onSelect: () => setOnly(null) },
            ...providers.map((provider) => ({
              label: nameOf(provider.engine),
              selected: only === provider.engine,
              onSelect: () => setOnly(provider.engine),
            })),
          ]}
        />
      ) : null}
    </dialog>
  );
}

