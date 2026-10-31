import { useLayoutEffect, useRef, useState } from "react";
import { axisTicks, formatTokens, type EngineTotals } from "./usageModel";

const HEIGHT = 200;
const PAD = { top: 8, right: 0, bottom: 22, left: 40 };

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`)
    .toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
    .toUpperCase();

/** Stacked daily tokens per engine. Hovering reads one day. */
export function UsageChart({
  engines,
  dates,
  colorOf,
  nameOf,
}: {
  engines: readonly EngineTotals[];
  dates: readonly string[];
  colorOf(engine: string): string;
  nameOf(engine: string): string;
}) {
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
      running += engine.daily.get(date) ?? 0;
      return running;
    });
  });
  const max = Math.max(0, ...stacks.map((stack) => stack.at(-1) ?? 0));
  const ticks = axisTicks(max);
  const top = ticks.at(-1) ?? 1;
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (at: number) => PAD.left + (dates.length > 1 ? (at / (dates.length - 1)) * plotW : plotW / 2);
  const y = (value: number) => PAD.top + plotH - (value / (top || 1)) * plotH;
  const line = (level: number) => stacks.map((stack, at) => `${x(at)},${y(stack[level] ?? 0)}`).join(" L ");
  const base = (level: number) =>
    stacks
      .map((stack, at) => `${x(at)},${y(level > 0 ? (stack[level - 1] ?? 0) : 0)}`)
      .reverse()
      .join(" L ");
  const labelAt = dates.length > 1 ? [0, Math.floor((dates.length - 1) / 2), dates.length - 1] : [0];
  const hovered = hover === null ? null : dates[hover];

  return (
    <div
      ref={box}
      className="usage-chart"
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - rect.left - PAD.left) / plotW;
        setHover(Math.min(dates.length - 1, Math.max(0, Math.round(ratio * (dates.length - 1)))));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg width={width} height={HEIGHT} role="img" aria-label="Daily processed tokens by engine">
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="usage-grid" x1={PAD.left} x2={width} y1={y(tick)} y2={y(tick)} />
            <text className="usage-tick" x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
              {formatTokens(tick)}
            </text>
          </g>
        ))}
        {dates.length > 1
          ? engines.map((engine, level) => (
              <g key={engine.engine}>
                <path d={`M ${line(level)} L ${base(level)} Z`} fill={colorOf(engine.engine)} opacity={0.14} />
                <path d={`M ${line(level)}`} fill="none" stroke={colorOf(engine.engine)} strokeWidth={1.5} />
              </g>
            ))
          : null}
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
        {hover !== null ? (
          <line className="usage-cursor" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
        ) : null}
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
              <b>{formatTokens(engine.daily.get(hovered) ?? 0)}</b>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
