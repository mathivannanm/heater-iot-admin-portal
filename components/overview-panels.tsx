"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useLiveDevices, useLiveFeed, useLiveStats, useNow } from "./live-store";
import { ChannelChip, SeverityBadge, StatusBadge, TrippedBadge } from "./status";
import { Badge, Card, CardHeader, Dot, EmptyState, cx } from "./ui/primitives";
import {
  FAULT_LABEL,
  HEAT_LEVEL_LABEL,
  formatAge,
  formatClock,
  formatCurrent,
  formatPower,
  formatTemp,
} from "@/lib/format";
import type { DeviceView, FaultCode, HeatLevel, StreamReason } from "@/lib/types";

/**
 * The panels below the summary strip: what needs attention, what is happening
 * right now, and how the fleet is distributed across heat levels and rooms.
 */

/** Ranks devices by how much they should worry an operator. */
function attentionScore(device: DeviceView): number {
  let score = 0;
  if (device.tripped) score += 1000;
  if (device.worstAlertSeverity === "critical") score += 500;
  score += device.faultCount * 100;
  if (device.worstAlertSeverity === "warning") score += 50;
  score += device.openAlertCount * 10;
  if (!device.online && device.offlineReason === "silent") score += 25;
  if (device.offlineReason === "never_seen") score += 5;
  if (device.online && device.stale) score += 2;
  return score;
}

function attentionReason(device: DeviceView): string {
  if (device.tripped) return "Protection tripped — power cut at the board";
  const faulted = device.channels.find((channel) => channel.reading && channel.reading.fault !== "ok");
  if (faulted && faulted.reading) {
    return `${faulted.name}: ${FAULT_LABEL[faulted.reading.fault].toLowerCase()}`;
  }
  if (device.openAlertCount > 0) {
    return `${device.openAlertCount} open alert${device.openAlertCount === 1 ? "" : "s"}`;
  }
  if (device.offlineReason === "never_seen") return "Provisioned but has never reported";
  if (!device.online) return `Silent since ${formatClock(device.lastSeenAt)}`;
  if (device.stale) return "Readings are older than the stale threshold";
  if (device.telemetry?.wifi === "AP") return "Fell back to its own access point";
  return "Healthy";
}

export function NeedsAttention() {
  const devices = useLiveDevices();

  const ranked = useMemo(
    () =>
      devices
        .map((device) => ({ device, score: attentionScore(device) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.device.name.localeCompare(b.device.name))
        .slice(0, 8),
    [devices],
  );

  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Needs attention"
        description="Ordered by urgency — trips and faults first, then silence"
        actions={
          <Link href="/devices?status=fault" className="text-xs font-medium text-accent hover:underline">
            View all
          </Link>
        }
      />
      {ranked.length === 0 ? (
        <EmptyState
          title="Everything is healthy"
          description="No trips, faults, open alerts or unexplained silence across the fleet."
        />
      ) : (
        <ul className="divide-y divide-border-base">
          {ranked.map(({ device }) => (
            <li key={device.id} className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
              <div className="min-w-0 flex-1">
                <Link href={`/devices/${device.id}`} className="text-sm font-medium hover:text-accent">
                  {device.name}
                </Link>
                <p className="mt-0.5 truncate text-xs text-muted">{attentionReason(device)}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {device.tripped ? <TrippedBadge /> : null}
                {device.worstAlertSeverity ? (
                  <SeverityBadge severity={device.worstAlertSeverity} />
                ) : null}
                <StatusBadge device={device} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const REASON_LABEL: Record<StreamReason, string> = {
  telemetry: "Telemetry",
  registered: "Registered",
  updated: "Updated",
  went_offline: "Went offline",
  came_online: "Came online",
  command: "Command queued",
  settings: "Settings changed",
};

const REASON_TONE: Record<StreamReason, "ok" | "warn" | "danger" | "neutral" | "accent"> = {
  telemetry: "neutral",
  registered: "accent",
  updated: "neutral",
  went_offline: "danger",
  came_online: "ok",
  command: "accent",
  settings: "warn",
};

/**
 * The live activity feed.
 *
 * Fed by the same SSE stream as everything else, so an entry appears the moment
 * the server publishes it. Routine telemetry is filtered out upstream - at a
 * frame every few seconds per device it would push everything else off screen
 * within a minute.
 */
export function ActivityFeed() {
  const feed = useLiveFeed();
  const now = useNow();

  return (
    <Card className="flex flex-col">
      <CardHeader title="Live activity" description="Transitions and alerts as they arrive" />
      {feed.length === 0 ? (
        <EmptyState
          title="Waiting for activity"
          description="Status changes, alerts and commands appear here as they happen."
        />
      ) : (
        <ul className="max-h-80 divide-y divide-border-base overflow-y-auto">
          {feed.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2.5 px-4 py-2 sm:px-5">
              <span className="mt-1.5">
                <Dot tone={entry.alert ? (entry.alert.severity === "critical" ? "danger" : "warn") : REASON_TONE[entry.reason]} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs">
                  <Link href={`/devices/${entry.deviceId}`} className="font-medium hover:text-accent">
                    {entry.deviceName}
                  </Link>
                  <span className="text-muted"> — {entry.alert ? entry.alert.message : REASON_LABEL[entry.reason]}</span>
                </p>
              </div>
              <span className="tabular shrink-0 text-[11px] text-muted">{formatAge(now - entry.t)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const LEVEL_BAR: Record<HeatLevel, string> = {
  off: "bg-idle",
  low: "bg-wifi",
  medium: "bg-warn",
  high: "bg-heat",
};

/** How the online fleet is distributed across heat levels. */
export function HeatDistribution() {
  const stats = useLiveStats();
  const levels: HeatLevel[] = ["off", "low", "medium", "high"];
  const total = levels.reduce((sum, level) => sum + stats.levels[level], 0);

  return (
    <Card>
      <CardHeader
        title="Heat levels"
        description={total === 0 ? "No devices reporting" : `${total} devices reporting`}
      />
      <div className="space-y-2.5 px-4 py-3.5 sm:px-5">
        {levels.map((level) => {
          const count = stats.levels[level];
          const share = total === 0 ? 0 : (count / total) * 100;
          return (
            <div key={level}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-medium">{HEAT_LEVEL_LABEL[level]}</span>
                <span className="tabular text-muted">
                  {count}
                  {total > 0 ? ` · ${Math.round(share)}%` : ""}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className={cx("h-full rounded-full transition-[width]", LEVEL_BAR[level])}
                  style={{ width: `${share}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Per-channel fault tally across the fleet. */
export function FaultBreakdown() {
  const stats = useLiveStats();
  const faults: FaultCode[] = ["over_current", "over_temperature", "no_load"];
  const anyFault = faults.some((fault) => stats.faults[fault] > 0);

  return (
    <Card>
      <CardHeader
        title="Channel health"
        description={`${stats.channelsOn} of ${stats.channelsTotal} channels switched on`}
      />
      <div className="px-4 py-3.5 sm:px-5">
        {!anyFault ? (
          <p className="text-xs text-muted">
            Every reporting channel reads <span className="font-medium text-ok">OK</span>.
          </p>
        ) : (
          <dl className="space-y-2">
            {faults.map((fault) =>
              stats.faults[fault] === 0 ? null : (
                <div key={fault} className="flex items-center justify-between gap-3 text-xs">
                  <dt className="flex items-center gap-2">
                    <Dot tone={fault === "no_load" ? "warn" : "danger"} />
                    {FAULT_LABEL[fault]}
                  </dt>
                  <dd className="tabular font-medium">{stats.faults[fault]}</dd>
                </div>
              ),
            )}
          </dl>
        )}
        {stats.tripped > 0 ? (
          <p className="mt-3 rounded-lg bg-danger-soft px-2.5 py-2 text-xs text-danger">
            {stats.tripped} device{stats.tripped === 1 ? " has" : "s have"} a latched protection trip.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** Which rooms are drawing power right now. */
export function RoomBreakdown() {
  const devices = useLiveDevices();

  const rooms = useMemo(() => {
    const map = new Map<string, { name: string; devices: number; online: number; powerW: number; hottest: number | null }>();

    for (const device of devices) {
      const name = device.roomName ?? "Unassigned";
      const entry = map.get(name) ?? { name, devices: 0, online: 0, powerW: 0, hottest: null };
      entry.devices += 1;
      if (device.online) {
        entry.online += 1;
        entry.powerW += device.telemetry?.totalPowerW ?? 0;
        if (device.hottestTempC !== null) {
          entry.hottest = entry.hottest === null ? device.hottestTempC : Math.max(entry.hottest, device.hottestTempC);
        }
      }
      map.set(name, entry);
    }

    return [...map.values()].sort((a, b) => b.powerW - a.powerW || a.name.localeCompare(b.name));
  }, [devices]);

  const peak = Math.max(1, ...rooms.map((room) => room.powerW));

  return (
    <Card>
      <CardHeader title="By room" description="Current draw and hottest probe per room" />
      {rooms.length === 0 ? (
        <EmptyState title="No devices yet" />
      ) : (
        <ul className="divide-y divide-border-base">
          {rooms.map((room) => (
            <li key={room.name} className="px-4 py-2.5 sm:px-5">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate font-medium">{room.name}</span>
                <span className="tabular shrink-0 text-muted">
                  {formatPower(room.powerW)}
                  {room.hottest !== null ? ` · ${formatTemp(room.hottest)}` : ""}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-heat transition-[width]"
                  style={{ width: `${(room.powerW / peak) * 100}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {room.online} of {room.devices} online
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A compact strip of every device's live channel state. */
export function ChannelWall() {
  const devices = useLiveDevices();
  const stats = useLiveStats();

  return (
    <Card>
      <CardHeader
        title="Channel wall"
        description={`Every relay across the fleet · ${formatCurrent(stats.totalCurrentA)} total draw`}
      />
      {devices.length === 0 ? (
        <EmptyState title="No devices yet" />
      ) : (
        <ul className="divide-y divide-border-base">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 sm:px-5">
              <Link
                href={`/devices/${device.id}`}
                className="min-w-0 flex-1 truncate text-xs font-medium hover:text-accent"
              >
                {device.name}
              </Link>
              <div className="flex flex-wrap gap-1">
                {device.channels.map((channel) => (
                  <ChannelChip key={channel.channelIndex} channel={channel} online={device.online} />
                ))}
              </div>
              {device.online && device.telemetry ? (
                <span className="tabular w-16 shrink-0 text-right text-[11px] text-muted">
                  {formatPower(device.telemetry.totalPowerW)}
                </span>
              ) : (
                <Badge tone="neutral">offline</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
