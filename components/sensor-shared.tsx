"use client";

import { useEffect, useRef } from "react";
import { useNow } from "./live-store";
import { Badge, Dot } from "./ui/primitives";
import { DEFAULT_SENSOR_LABEL, type SensorDevice, type SensorKey, type SensorSettings } from "@/lib/sensor-types";
import type { SignalInfo } from "@/lib/types";

/** Pieces shared by the sensor list and the sensor detail page. */

export const POLL_INTERVAL_MS = 5_000;

/** The spec's marker for a sensor that is not reading; never a zero. */
export const NO_READING = "--";

/**
 * Series colours, fixed per sensor so T3 is the same colour in the chart, the
 * legend and the statistics table whatever else is on screen. The steps were
 * chosen with a colour-vision validator against the white card surface; the
 * two lightest (T3, T4) sit under 3:1 contrast, which is why every chart here
 * also has a legend and a table of the same numbers.
 */
export const SENSOR_COLOUR: Record<SensorKey, string> = {
  t1: "#2a78d6",
  t2: "#eb6834",
  t3: "#1baf7a",
  t4: "#eda100",
  h1: "#4a3aa7",
  h2: "#008300",
};

/** What a sensor is called on screen: its key, plus the operator's name for it. */
export function sensorName(key: SensorKey, settings: SensorSettings): string {
  const label = settings.labels[key];
  return label ? `${DEFAULT_SENSOR_LABEL[key]} · ${label}` : DEFAULT_SENSOR_LABEL[key];
}

export function formatReading(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return NO_READING;
  return `${value.toFixed(1)}${unit}`;
}

/**
 * When the server's clock was last compared with this browser's. Null until
 * the first poll returns, in which case the two are assumed to agree.
 */
export interface ClockSync {
  serverTime: number;
  receivedAt: number;
}

/**
 * The server's idea of now, ticking once a second.
 *
 * "Online" is a question about how long ago the server heard from a board, so
 * it has to be asked on the server's clock. A laptop that runs two minutes
 * fast would otherwise show every sensor as offline.
 */
export function useServerNow(sync: ClockSync | null): number {
  const now = useNow();
  return sync === null ? now : now + (sync.serverTime - sync.receivedAt);
}

export interface LiveStatus {
  online: boolean;
  /** Null when the board has never reported. */
  ageMs: number | null;
}

/** Re-derives online/offline between polls, so the badge flips on time. */
export function liveStatus(
  sensor: Pick<SensorDevice, "lastSeenAt">,
  serverNow: number,
  offlineTimeoutMs: number,
): LiveStatus {
  if (sensor.lastSeenAt === null) return { online: false, ageMs: null };
  const ageMs = Math.max(0, serverNow - sensor.lastSeenAt);
  return { online: ageMs <= offlineTimeoutMs, ageMs };
}

/** The signal to draw: the measured one while online, "offline" once it is not. */
export function liveSignal(sensor: SensorDevice, online: boolean): SignalInfo {
  if (online) return sensor.signal;
  return { rssiDbm: null, quality: null, label: null, bars: 0, percent: null, reason: "offline" };
}

export function OnlineBadge({ status }: { status: LiveStatus }) {
  if (status.online) {
    return (
      <Badge tone="ok">
        <Dot tone="ok" pulse />
        Online
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" title={status.ageMs === null ? "Never reported" : "Stopped reporting"}>
      <Dot tone="neutral" />
      {status.ageMs === null ? "Never seen" : "Offline"}
    </Badge>
  );
}

/**
 * Calls `tick` every `intervalMs` while the tab is visible, and once more the
 * moment it becomes visible again. A hidden tab polls nothing.
 */
export function usePolling(tick: () => void, intervalMs: number): void {
  const latest = useRef(tick);
  useEffect(() => {
    latest.current = tick;
  }, [tick]);

  useEffect(() => {
    const run = () => {
      if (!document.hidden) latest.current();
    };
    const timer = setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [intervalMs]);
}
