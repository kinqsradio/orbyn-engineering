import { useLayoutEffect, useRef, useState } from "react";
import { axisTicks, formatTokens, formatUsd, type EngineTotals } from "./usageModel";

const HEIGHT = 200;
const PAD = { top: 8, right: 0, bottom: 22, left: 40 };

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`)
    .toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
    .toUpperCase();

/** Stacked daily tokens or priced cost per engine. Hovering reads one day. */
export function UsageChart({
  engines,
  dates,
  colorOf,
  nameOf,
  metric = "tokens",
}: {
  engines: readonly EngineTotals[];
  dates: readonly string[];
  colorOf(engine: string): string;
  nameOf(engine: string): string;
  metric?: "cost" | "tokens";
}) {
  const valueOf = (engine: EngineTotals, date: string) =>
    (metric === "cost" ? engine.dailyCost.get(date) : engine.daily.get(date)) ?? 0;
  const format = metric === "cost" ? formatUsd : formatTokens;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    setWidth(element.clientWidth || 600);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const stacks = dates.map((date) => {
    let running = 0;
    return engines.map((engine) => {
      running += valueOf(engine, date);
      return running;
    });
  });
  const max = Math.max(0, ...stacks.map((stack) => stack.at(-1) ?? 0));
  const ticks = axisTicks(max);
  const top = ticks.at(-1) ?? 1;
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, dates.length);
  const x = (at: number) => PAD.left + (at + 0.5) * slot;
  const y = (value: number) => PAD.top + plotH - (value / (top || 1)) * plotH;
  const labelAt = dates.length > 1 ? [0, Math.floor((dates.length - 1) / 2), dates.length - 1] : [0];
  const hovered = hover === null ? null : dates[hover];

  return (
    <div
      ref={box}
      className="usage-chart"
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - rect.left - PAD.left) / plotW;
        setHover(Math.min(dates.length - 1, Math.max(0, Math.floor(ratio * dates.length))));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg width={width} height={HEIGHT} role="img" aria-label={metric === "cost" ? "Daily estimated cost by engine" : "Daily processed tokens by engine"}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="usage-grid" x1={PAD.left} x2={width} y1={y(tick)} y2={y(tick)} />
            <text className="usage-tick" x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        ))}
        {dates.map((date, at) =>
          engines.map((engine, level) => {
            const low = level > 0 ? (stacks[at]?.[level - 1] ?? 0) : 0;
            const high = stacks[at]?.[level] ?? 0;
            if (high <= low) return null;
            return (
              <rect
                key={`${date}:${engine.engine}`}
                className="usage-bar"
                x={x(at) - Math.max(1, slot * 0.35)}
                width={Math.max(2, slot * 0.7)}
                y={y(high)}
                height={y(low) - y(high)}
                rx={2}
                fill={colorOf(engine.engine)}
                opacity={hover === null || hover === at ? 0.85 : 0.4}
              />
            );
          }),
        )}
        {labelAt.map((at) => (
          <text
            key={at}
            className="usage-tick"
            x={x(at)}
            y={HEIGHT - 6}
            textAnchor={at === 0 ? "start" : at === dates.length - 1 ? "end" : "middle"}
          >
            {shortDate(dates[at] ?? "")}
          </text>
        ))}
      </svg>
      {hovered ? (
        <div
          className="usage-tip"
          style={{
            left: Math.min(width - 168, Math.max(0, x(hover ?? 0) + 8)),
            top: PAD.top,
          }}
        >
          <strong>{shortDate(hovered)}</strong>
          {engines.map((engine) => (
            <span key={engine.engine}>
              <span className="usage-dot" style={{ background: colorOf(engine.engine) }} />
              {nameOf(engine.engine)}
              <b>{format(valueOf(engine, hovered))}</b>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
