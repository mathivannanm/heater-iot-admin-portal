/**
 * The current time, and the windows the history views are built from.
 *
 * Reading the clock is impure, and calling `Date.now()` straight from a
 * component body trips the React Compiler's purity rule. These pages are
 * `force-dynamic` and are re-rendered per request, so reading the clock is
 * exactly right — it just belongs behind a named function rather than inline in
 * render, which is also where a test can substitute it.
 */

export function nowMs(): number {
  return Date.now();
}

export interface TimeWindow {
  from: number;
  to: number;
}

/** A window of `spanMs` ending now. */
export function windowEndingNow(spanMs: number): TimeWindow {
  const to = nowMs();
  return { from: to - spanMs, to };
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

// ------------------------------------------------------------ zoned calendar

/**
 * The offset of `timeZone` from UTC at instant `t`, in milliseconds. Positive
 * east of Greenwich (Asia/Kolkata is +19 800 000).
 */
export function zoneOffsetMs(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  // Sub-second remainder is dropped by the formatter, so compare whole seconds.
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * Midnight at the start of the calendar day containing `t` in `timeZone`.
 * Evaluated twice so a DST change inside the day resolves to the real local
 * midnight rather than one shifted by the old offset.
 */
export function startOfDayInZone(t: number, timeZone: string): number {
  let guess = t - ((t + zoneOffsetMs(t, timeZone)) % DAY_MS);
  guess = t - ((t + zoneOffsetMs(guess, timeZone)) % DAY_MS);
  return guess;
}

/**
 * Evenly spaced tick instants for a time axis, aligned to clock boundaries in
 * `timeZone` so a day reads 00:00, 04:00, 08:00 … rather than wherever the
 * window happened to start. Returns the step so callers can label the ticks.
 */
export function timeAxisTicks(
  from: number,
  to: number,
  timeZone: string,
  target = 6,
): { ticks: number[]; stepMs: number } {
  const span = Math.max(to - from, 1);
  const candidates = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    HOUR_MS,
    2 * HOUR_MS,
    3 * HOUR_MS,
    4 * HOUR_MS,
    6 * HOUR_MS,
    12 * HOUR_MS,
    DAY_MS,
    2 * DAY_MS,
    7 * DAY_MS,
  ];
  const stepMs = candidates.find((step) => span / step <= target) ?? candidates[candidates.length - 1];
  const offset = zoneOffsetMs(from, timeZone);
  const first = Math.ceil((from + offset) / stepMs) * stepMs - offset;
  const ticks: number[] = [];
  for (let t = first; t <= to; t += stepMs) ticks.push(t);
  return { ticks, stepMs };
}
