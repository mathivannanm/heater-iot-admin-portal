"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "./ui/primitives";
import { timeAxisTicks } from "@/lib/clock";
import { DISPLAY_TIME_ZONE, formatAxisTime, formatClock, formatDuration } from "@/lib/format";

/**
 * Dependency-free SVG charts sized to their container.
 *
 * Monitoring charts, not decoration: the x axis is real time over the whole
 * requested window, so an hour with no frames takes up an hour of width
 * instead of being squeezed out; offline periods are shaded; and every series
 * carries its units.
 */

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

export interface Series {
  key: string;
  label: string;
  colour: string;
  values: Array<number | null>;
  /** Dashed lines read as "setpoint" rather than "measurement". */
  dashed?: boolean;
  unit?: string;
  decimals?: number;
}

const PADDING = { top: 12, right: 12, bottom: 22, left: 40 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step / 1000; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return ticks;
}

/** A shaded period behind a chart, used for outages. */
export interface ChartBand {
  from: number;
  to: number;
  label: string;
  colour: string;
}

/** Nearest index in a sorted timestamp array to instant `t`. */
function nearestIndex(timestamps: number[], t: number): number {
  let lo = 0;
  let hi = timestamps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(timestamps[lo - 1] - t) < Math.abs(timestamps[lo] - t)) return lo - 1;
  return lo;
}

function useTimeAxis(timestamps: number[], from?: number, to?: number, innerWidth = 10) {
  const domainFrom = from ?? timestamps[0] ?? 0;
  const domainTo = Math.max(to ?? timestamps[timestamps.length - 1] ?? domainFrom + 1, domainFrom + 1);
  const span = domainTo - domainFrom;

  const xAtTime = useCallback(
    (t: number) => PADDING.left + ((t - domainFrom) / span) * innerWidth,
    [domainFrom, span, innerWidth],
  );

  const ticks = useMemo(
    () =>
      timeAxisTicks(domainFrom, domainTo, DISPLAY_TIME_ZONE, Math.max(3, Math.floor(innerWidth / 90)))
        .ticks,
    [domainFrom, domainTo, innerWidth],
  );

  return { domainFrom, domainTo, span, xAtTime, ticks };
}

/**
 * Multi-series line chart over a shared time axis.
 * `timestamps` and every series' `values` are index-aligned. `from` / `to`
 * fix the axis to the requested window (default: first to last sample);
 * `bands` are shaded behind the lines and `states` annotate the tooltip.
 */
export function TimeSeriesChart({
  timestamps,
  series,
  height = 200,
  yLabel,
  yMin,
  yMax,
  from,
  to,
  bands = [],
  states,
  emptyMessage = "No data in this range",
}: {
  timestamps: number[];
  series: Series[];
  height?: number;
  yLabel?: string;
  yMin?: number;
  yMax?: number;
  from?: number;
  to?: number;
  bands?: ChartBand[];
  states?: Array<string | null>;
  emptyMessage?: string;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const hasData = series.some((s) => s.values.some((v) => v !== null));

  const domain = useMemo(() => {
    const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (!values.length) return { min: 0, max: 1 };
    let min = yMin ?? Math.min(...values);
    let max = yMax ?? Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    return { min: yMin ?? min - pad, max: yMax ?? max + pad };
  }, [series, yMin, yMax]);

  const innerWidth = Math.max(width - PADDING.left - PADDING.right, 10);
  const innerHeight = height - PADDING.top - PADDING.bottom;

  const { domainFrom, domainTo, span, xAtTime, ticks } = useTimeAxis(timestamps, from, to, innerWidth);

  const xAt = useCallback((index: number) => xAtTime(timestamps[index]), [xAtTime, timestamps]);

  const yAt = useCallback(
    (value: number) =>
      PADDING.top +
      innerHeight -
      ((value - domain.min) / (domain.max - domain.min)) * innerHeight,
    [domain, innerHeight],
  );

  // Each contiguous run of non-null values becomes its own path, so coverage
  // gaps stay visible instead of being bridged.
  const paths = useMemo(
    () =>
      series.map((s) => {
        const segments: string[] = [];
        let current: string[] = [];
        s.values.forEach((value, index) => {
          if (value === null) {
            if (current.length > 1) segments.push(current.join(" "));
            current = [];
            return;
          }
          current.push(`${current.length ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`);
        });
        if (current.length > 1) segments.push(current.join(" "));
        return { series: s, d: segments.join(" ") };
      }),
    [series, xAt, yAt],
  );

  const yTicks = useMemo(() => niceTicks(domain.min, domain.max, 4), [domain]);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!timestamps.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left - PADDING.left;
    const ratio = Math.min(Math.max(x / innerWidth, 0), 1);
    setHoverIndex(nearestIndex(timestamps, domainFrom + ratio * span));
  };

  const clampX = (t: number) => Math.min(Math.max(xAtTime(t), PADDING.left), width - PADDING.right);

  return (
    <div ref={ref} className="relative w-full">
      {!hasData ? (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-border-base text-xs text-muted"
          style={{ height }}
        >
          {emptyMessage}
        </div>
      ) : (
        <>
          <svg
            width={width || 300}
            height={height}
            role="img"
            aria-label={yLabel ? `${yLabel} over time` : "Time series"}
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
          >
            {bands.map((band, index) => {
              const x1 = clampX(band.from);
              const x2 = clampX(band.to);
              if (x2 - x1 < 0.5) return null;
              return (
                <rect
                  key={`${band.from}-${index}`}
                  x={x1}
                  y={PADDING.top}
                  width={x2 - x1}
                  height={innerHeight}
                  fill={band.colour}
                  opacity={0.18}
                >
                  <title>{`${band.label} · ${formatClock(band.from)} → ${formatClock(band.to)} (${formatDuration(band.to - band.from)})`}</title>
                </rect>
              );
            })}

            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PADDING.left}
                  x2={width - PADDING.right}
                  y1={yAt(tick)}
                  y2={yAt(tick)}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <text
                  x={PADDING.left - 6}
                  y={yAt(tick) + 3}
                  textAnchor="end"
                  className="fill-[var(--muted)] text-[10px]"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {tick}
                </text>
              </g>
            ))}

            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={xAtTime(tick)}
                  x2={xAtTime(tick)}
                  y1={PADDING.top + innerHeight}
                  y2={PADDING.top + innerHeight + 4}
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                />
                <text
                  x={xAtTime(tick)}
                  y={height - 6}
                  textAnchor={tick <= domainFrom ? "start" : tick >= domainTo ? "end" : "middle"}
                  className="fill-[var(--muted)] text-[10px]"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatAxisTime(tick, span)}
                </text>
              </g>
            ))}

            {paths.map(({ series: s, d }) => (
              <path
                key={s.key}
                d={d}
                fill="none"
                stroke={s.colour}
                strokeWidth={s.dashed ? 1.5 : 2}
                strokeDasharray={s.dashed ? "4 3" : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {hoverIndex !== null && timestamps[hoverIndex] !== undefined ? (
              <>
                <line
                  x1={xAt(hoverIndex)}
                  x2={xAt(hoverIndex)}
                  y1={PADDING.top}
                  y2={PADDING.top + innerHeight}
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                />
                {series.map((s) => {
                  const value = s.values[hoverIndex];
                  if (value === null || value === undefined) return null;
                  return (
                    <circle
                      key={s.key}
                      cx={xAt(hoverIndex)}
                      cy={yAt(value)}
                      r={3}
                      fill="var(--surface)"
                      stroke={s.colour}
                      strokeWidth={2}
                    />
                  );
                })}
              </>
            ) : null}
          </svg>

          {hoverIndex !== null && timestamps[hoverIndex] !== undefined ? (
            <div
              className="pointer-events-none absolute top-1 rounded-lg border border-border-base bg-surface-raised px-2 py-1.5 text-[11px] shadow-[var(--shadow-card)]"
              style={{
                left: Math.min(Math.max(xAt(hoverIndex) - 60, 0), Math.max(width - 130, 0)),
              }}
            >
              <p className="tabular text-muted">{formatClock(timestamps[hoverIndex])}</p>
              {states?.[hoverIndex] ? (
                <p className="font-medium text-danger">{states[hoverIndex]}</p>
              ) : null}
              {series.map((s) => {
                const value = s.values[hoverIndex];
                return (
                  <p key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: s.colour }}
                    />
                    <span className="text-muted">{s.label}</span>
                    <span className="tabular font-medium">
                      {value === null || value === undefined
                        ? "no data"
                        : `${value.toFixed(s.decimals ?? 1)}${s.unit ?? ""}`}
                    </span>
                  </p>
                );
              })}
            </div>
          ) : null}
        </>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className={cx("inline-block h-0.5 w-4 rounded-full")}
              style={{
                background: s.dashed
                  ? `repeating-linear-gradient(90deg, ${s.colour} 0 4px, transparent 4px 7px)`
                  : s.colour,
              }}
            />
            {s.label}
          </span>
        ))}
        {bands.length > 0 ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className="inline-block h-2.5 w-4 rounded-sm"
              style={{ background: bands[0].colour, opacity: 0.35 }}
            />
            {bands[0].label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Duty-cycle bars: how much of each bucket the element was actually running.
 * More honest than an ON/OFF line, which hides fast cycling. Bars sit at
 * their real time on the axis, `stepMs` wide.
 */
export function DutyChart({
  timestamps,
  duty,
  from,
  to,
  stepMs,
  bands = [],
  height = 90,
}: {
  timestamps: number[];
  duty: Array<number | null>;
  from?: number;
  to?: number;
  stepMs?: number;
  bands?: ChartBand[];
  height?: number;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const hasData = duty.some((value) => value !== null);
  const innerWidth = Math.max(width - PADDING.left - PADDING.right, 10);
  const innerHeight = height - 18;
  const { span, xAtTime } = useTimeAxis(timestamps, from, to, innerWidth);
  const step =
    stepMs ??
    (timestamps.length > 1 ? (timestamps[timestamps.length - 1] - timestamps[0]) / (timestamps.length - 1) : span);
  const barWidth = Math.max((step / span) * innerWidth - 1, 1);
  const clampX = (t: number) => Math.min(Math.max(xAtTime(t), PADDING.left), width - PADDING.right);

  return (
    <div ref={ref} className="w-full">
      {!hasData ? (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-border-base text-xs text-muted"
          style={{ height }}
        >
          No heater activity recorded in this range
        </div>
      ) : (
        <svg width={width || 300} height={height} role="img" aria-label="Heater duty cycle over time">
          {bands.map((band, index) => {
            const x1 = clampX(band.from);
            const x2 = clampX(band.to);
            if (x2 - x1 < 0.5) return null;
            return (
              <rect
                key={`${band.from}-${index}`}
                x={x1}
                y={4}
                width={x2 - x1}
                height={innerHeight - 4}
                fill={band.colour}
                opacity={0.18}
              >
                <title>{`${band.label} · ${formatClock(band.from)} → ${formatClock(band.to)}`}</title>
              </rect>
            );
          })}
          <line
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={innerHeight}
            y2={innerHeight}
            stroke="var(--border)"
          />
          <text
            x={PADDING.left - 6}
            y={12}
            textAnchor="end"
            className="fill-[var(--muted)] text-[10px]"
          >
            100%
          </text>
          <text
            x={PADDING.left - 6}
            y={innerHeight}
            textAnchor="end"
            className="fill-[var(--muted)] text-[10px]"
          >
            0%
          </text>
          {duty.map((value, index) => {
            if (value === null || value === 0) return null;
            const barHeight = Math.max(value * (innerHeight - 6), 1.5);
            return (
              <rect
                key={index}
                x={xAtTime(timestamps[index])}
                y={innerHeight - barHeight}
                width={barWidth}
                height={barHeight}
                rx={1}
                fill="var(--heat)"
                opacity={0.35 + value * 0.65}
              >
                <title>{`${formatClock(timestamps[index])} — heating ${Math.round(value * 100)}% of the interval`}</title>
              </rect>
            );
          })}
        </svg>
      )}
    </div>
  );
}

export interface TimelineSpan {
  from: number;
  to: number;
  label: string;
  colour: string;
}

/**
 * Horizontal state timeline over a window. Each span is placed at its real
 * position between `from` and `to`, so time with no spans stays blank rather
 * than the spans being packed to the left.
 */
export function TimelineStrip({
  spans,
  from,
  to,
  height = 26,
  emptyMessage = "No connection history in this range",
}: {
  spans: TimelineSpan[];
  from: number;
  to: number;
  height?: number;
  emptyMessage?: string;
}) {
  const total = Math.max(to - from, 1);
  const ticks = useMemo(() => timeAxisTicks(from, to, DISPLAY_TIME_ZONE, 6).ticks, [from, to]);

  if (!spans.length) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-border-base text-xs text-muted"
        style={{ height: height + 12 }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      <div
        className="relative w-full overflow-hidden rounded-md border border-border-base bg-surface-muted"
        style={{ height }}
      >
        {spans.map((span, index) => {
          const start = Math.max(span.from, from);
          const end = Math.min(span.to, to);
          const leftPercent = ((start - from) / total) * 100;
          const widthPercent = (Math.max(end - start, 0) / total) * 100;
          if (widthPercent <= 0) return null;
          return (
            <div
              key={`${span.from}-${index}`}
              title={`${span.label} · ${formatClock(span.from)} → ${formatClock(span.to)} (${formatDuration(span.to - span.from)})`}
              style={{
                left: `${leftPercent}%`,
                width: `${Math.max(widthPercent, 0.15)}%`,
                background: span.colour,
              }}
              className="absolute top-0 h-full"
            />
          );
        })}
      </div>
      <div className="tabular relative mt-1 h-3.5 text-[10px] text-muted">
        {ticks.map((tick) => (
          <span
            key={tick}
            className="absolute -translate-x-1/2"
            style={{ left: `${((tick - from) / total) * 100}%` }}
          >
            {formatAxisTime(tick, total)}
          </span>
        ))}
      </div>
    </div>
  );
}
