"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatAxisTime, formatDateTime } from "@/lib/format";

/**
 * Line chart for the sensor page, drawn against a true time axis.
 *
 * The heater charts space their points evenly by index, which is fine while a
 * board reports steadily. A sensor log is read for its holes: a probe that was
 * unplugged, a board that lost power overnight. So here a point sits where its
 * timestamp puts it, and the line is broken wherever a value is null or the
 * board was silent for longer than `maxGapMs` - never drawn down to zero and
 * never bridged across the outage.
 */

export interface SensorSeries {
  key: string;
  label: string;
  colour: string;
  values: Array<number | null>;
}

export interface ThresholdLine {
  key: string;
  label: string;
  value: number;
}

const PADDING = { top: 14, right: 14, bottom: 24, left: 42 };

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
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step / 1000; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return ticks;
}

/** Index of the timestamp closest to `t`. `timestamps` is ascending. */
function nearestIndex(timestamps: number[], t: number): number {
  let low = 0;
  let high = timestamps.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (timestamps[middle] < t) low = middle;
    else high = middle;
  }
  return Math.abs(timestamps[low] - t) <= Math.abs(timestamps[high] - t) ? low : high;
}

export function SensorChart({
  title,
  timestamps,
  series,
  from,
  to,
  unit,
  decimals = 1,
  thresholds = [],
  maxGapMs,
  height = 240,
  emptyMessage = "No readings in this range",
}: {
  /** Names the chart for assistive technology, e.g. "Temperature". */
  title: string;
  timestamps: number[];
  series: SensorSeries[];
  from: number;
  to: number;
  unit: string;
  decimals?: number;
  thresholds?: ThresholdLine[];
  /** A silence longer than this between two points breaks the line. */
  maxGapMs: number;
  height?: number;
  emptyMessage?: string;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const hasData = series.some((s) => s.values.some((value) => value !== null));
  const span = Math.max(to - from, 1);
  const innerWidth = Math.max(width - PADDING.left - PADDING.right, 10);
  const innerHeight = height - PADDING.top - PADDING.bottom;

  const domain = useMemo(() => {
    const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (values.length === 0) return { min: 0, max: 1 };

    let min = Math.min(...values);
    let max = Math.max(...values);
    // A limit is drawn when it is near the data. One far outside it would
    // flatten every line into a smear at the bottom of the plot.
    const reach = Math.max(max - min, 4) * 1.5;
    for (const threshold of thresholds) {
      if (threshold.value > max && threshold.value - max <= reach) max = threshold.value;
      if (threshold.value < min && min - threshold.value <= reach) min = threshold.value;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.1;
    return { min: min - pad, max: max + pad };
  }, [series, thresholds]);

  const xAt = (t: number) => PADDING.left + ((t - from) / span) * innerWidth;
  const yAt = (value: number) =>
    PADDING.top + innerHeight - ((value - domain.min) / (domain.max - domain.min)) * innerHeight;

  // Each unbroken run becomes its own path. A run of one has no length to
  // draw, so it is kept as a dot: a single reading between two outages is
  // still a reading.
  const marks = series.map((s) => {
    const segments: string[] = [];
    const dots: Array<{ x: number; y: number }> = [];
    let run: Array<{ x: number; y: number }> = [];

    const flush = () => {
      if (run.length === 1) dots.push(run[0]);
      else if (run.length > 1) {
        segments.push(
          run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "),
        );
      }
      run = [];
    };

    s.values.forEach((value, index) => {
      const t = timestamps[index];
      if (value === null || t < from || t > to) {
        flush();
        return;
      }
      if (run.length > 0 && t - timestamps[index - 1] > maxGapMs) flush();
      run.push({ x: xAt(t), y: yAt(value) });
    });
    flush();

    return { series: s, d: segments.join(" "), dots };
  });

  const yTicks = niceTicks(domain.min, domain.max, 4);
  const xTicks = Array.from({ length: 5 }, (_, i) => from + (span * i) / 4);
  const visibleThresholds = thresholds.filter(
    (threshold) => threshold.value >= domain.min && threshold.value <= domain.max,
  );

  const moveTo = (clientX: number, bounds: DOMRect) => {
    if (timestamps.length === 0) return;
    const ratio = Math.min(Math.max((clientX - bounds.left - PADDING.left) / innerWidth, 0), 1);
    setHoverIndex(nearestIndex(timestamps, from + ratio * span));
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (timestamps.length === 0) return;
    if (event.key === "Escape") {
      setHoverIndex(null);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setHoverIndex((current) =>
      Math.min(Math.max((current ?? timestamps.length - 1) + step, 0), timestamps.length - 1),
    );
  };

  const hoverT = hoverIndex === null ? undefined : timestamps[hoverIndex];
  const hoverX = hoverT === undefined ? 0 : xAt(hoverT);

  return (
    <div ref={ref} className="relative w-full">
      {!hasData ? (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-border-base text-xs text-muted"
          style={{ height }}
        >
          {emptyMessage}
        </div>
      ) : width === 0 ? (
        // Measured on mount; holding the space stops the page jumping.
        <div style={{ height }} />
      ) : (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            tabIndex={0}
            aria-label={`${title} over time, in ${unit}. Use the arrow keys to read values.`}
            className="touch-pan-y rounded-sm"
            onPointerMove={(event) => moveTo(event.clientX, event.currentTarget.getBoundingClientRect())}
            onPointerDown={(event) => moveTo(event.clientX, event.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setHoverIndex(null)}
            onBlur={() => setHoverIndex(null)}
            onKeyDown={onKeyDown}
          >
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

            {xTicks.map((tick, index) => (
              <text
                key={tick}
                x={xAt(tick)}
                y={height - 6}
                textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
                className="fill-[var(--muted)] text-[10px]"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatAxisTime(tick, span)}
              </text>
            ))}

            {visibleThresholds.map((threshold) => (
              <g key={threshold.key}>
                <line
                  x1={PADDING.left}
                  x2={width - PADDING.right}
                  y1={yAt(threshold.value)}
                  y2={yAt(threshold.value)}
                  stroke="var(--danger)"
                  strokeWidth={1}
                  strokeDasharray="5 4"
                />
                <text
                  x={width - PADDING.right - 2}
                  y={yAt(threshold.value) - 4}
                  textAnchor="end"
                  className="fill-[var(--muted-strong)] text-[10px]"
                  // A halo in the surface colour keeps the label readable
                  // where a line runs behind it.
                  style={{ paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: 3 }}
                >
                  {threshold.label} {threshold.value.toFixed(decimals)}
                  {unit}
                </text>
              </g>
            ))}

            {marks.map(({ series: s, d, dots }) => (
              <g key={s.key}>
                {d ? (
                  <path
                    d={d}
                    fill="none"
                    stroke={s.colour}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ) : null}
                {dots.map((dot, index) => (
                  <circle key={index} cx={dot.x} cy={dot.y} r={2.5} fill={s.colour} />
                ))}
              </g>
            ))}

            {hoverT !== undefined ? (
              <>
                <line
                  x1={hoverX}
                  x2={hoverX}
                  y1={PADDING.top}
                  y2={PADDING.top + innerHeight}
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                />
                {series.map((s) => {
                  const value = s.values[hoverIndex!];
                  if (value === null || value === undefined) return null;
                  return (
                    <circle
                      key={s.key}
                      cx={hoverX}
                      cy={yAt(value)}
                      r={4}
                      fill={s.colour}
                      stroke="var(--surface)"
                      strokeWidth={2}
                    />
                  );
                })}
              </>
            ) : null}
          </svg>

          {hoverT !== undefined ? (
            <div
              className="pointer-events-none absolute top-1 min-w-[132px] rounded-lg border border-border-base bg-surface-raised px-2.5 py-2 text-[11px] shadow-[var(--shadow-card)]"
              style={
                // Sits beside the crosshair, on whichever side has the room.
                hoverX > width / 2 ? { right: width - hoverX + 10 } : { left: hoverX + 10 }
              }
            >
              <p className="tabular mb-1 text-muted">{formatDateTime(hoverT)}</p>
              {series.map((s) => {
                const value = s.values[hoverIndex!];
                return (
                  <p key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                    <span
                      aria-hidden
                      className="inline-block h-0.5 w-3 shrink-0 rounded-full"
                      style={{ background: s.colour }}
                    />
                    <span className="tabular font-semibold text-foreground">
                      {value === null || value === undefined
                        ? "--"
                        : `${value.toFixed(decimals)}${unit}`}
                    </span>
                    <span className="text-muted">
                      {value === null || value === undefined ? `${s.label} · no reading` : s.label}
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
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted-strong">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded-full"
              style={{ background: s.colour }}
            />
            {s.label}
          </span>
        ))}
        {visibleThresholds.length > 0 ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-strong">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4"
              style={{
                background:
                  "repeating-linear-gradient(90deg, var(--danger) 0 5px, transparent 5px 9px)",
              }}
            />
            Alert limit
          </span>
        ) : null}
      </div>
    </div>
  );
}
