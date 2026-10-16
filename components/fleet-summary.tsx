"use client";

import Link from "next/link";
import { useLiveStats, useStreamStatus } from "./live-store";
import { Dot, cx } from "./ui/primitives";
import { formatAge, formatCurrent, formatPower, formatTemp } from "@/lib/format";

/**
 * The summary strip.
 *
 * Every tile is a link into the device list with the matching filter already
 * applied, because the question after "three devices are faulted" is always
 * "which three". Tiles that count nothing are still shown - a zero is
 * information, and a strip whose tiles move around is hard to scan.
 */

interface Tile {
  key: string;
  label: string;
  value: string;
  hint?: string;
  href?: string;
  tone?: "neutral" | "ok" | "warn" | "danger" | "heat" | "wifi";
  emphasis?: boolean;
}

export function FleetSummary() {
  const stats = useLiveStats();

  const tiles: Tile[] = [
    {
      key: "total",
      label: "Devices",
      value: String(stats.total),
      hint: `${stats.channelsTotal} channels configured`,
      href: "/devices",
    },
    {
      key: "online",
      label: "Online",
      value: String(stats.online),
      hint:
        stats.neverSeen > 0
          ? `${stats.offline} offline, ${stats.neverSeen} never reported`
          : `${stats.offline} offline`,
      href: "/devices?status=online",
      tone: stats.online > 0 ? "ok" : "neutral",
    },
    {
      key: "heating",
      label: "Heating",
      value: String(stats.heating),
      hint: `${stats.channelsOn} of ${stats.channelsTotal} channels on`,
      href: "/devices?status=heating",
      tone: stats.heating > 0 ? "heat" : "neutral",
    },
    {
      key: "power",
      label: "Fleet draw",
      value: formatPower(stats.totalPowerW),
      hint: formatCurrent(stats.totalCurrentA),
      tone: stats.totalPowerW > 0 ? "heat" : "neutral",
    },
    {
      key: "temp",
      label: "Hottest probe",
      value: formatTemp(stats.hottestTempC),
      hint:
        stats.averageTempC === null ? "no readings" : `fleet average ${formatTemp(stats.averageTempC)}`,
      href: "/devices?sortBy=temperature&sortDir=desc",
    },
    {
      key: "alerts",
      label: "Open alerts",
      value: String(stats.openAlerts),
      hint: stats.criticalAlerts > 0 ? `${stats.criticalAlerts} critical` : "none critical",
      href: "/alerts",
      tone: stats.criticalAlerts > 0 ? "danger" : stats.openAlerts > 0 ? "warn" : "neutral",
      emphasis: stats.criticalAlerts > 0,
    },
    {
      key: "faults",
      label: "Channel faults",
      value: String(stats.channelFaults),
      hint: stats.tripped > 0 ? `${stats.tripped} tripped` : "no trips",
      href: "/devices?status=fault",
      tone: stats.channelFaults > 0 || stats.tripped > 0 ? "danger" : "neutral",
      emphasis: stats.tripped > 0,
    },
    {
      key: "link",
      label: "Connectivity",
      value: `${stats.wifiSta}/${stats.online || 0}`,
      hint:
        stats.wifiAp > 0
          ? `${stats.wifiAp} in AP mode, ${stats.bluetoothClients} BLE`
          : `on home Wi-Fi · ${stats.bluetoothClients} BLE`,
      href: stats.wifiAp > 0 ? "/devices?connection=ap" : "/devices",
      tone: stats.wifiAp > 0 ? "warn" : "wifi",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
      {tiles.map((tile) => (
        <SummaryTile key={tile.key} tile={tile} />
      ))}
    </div>
  );
}

const TONE_VALUE: Record<NonNullable<Tile["tone"]>, string> = {
  neutral: "text-foreground",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  heat: "text-heat",
  wifi: "text-wifi",
};

function SummaryTile({ tile }: { tile: Tile }) {
  const body = (
    <>
      <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{tile.label}</p>
      <p className={cx("mt-1 tabular text-2xl font-semibold leading-none", TONE_VALUE[tile.tone ?? "neutral"])}>
        {tile.value}
      </p>
      {tile.hint ? <p className="mt-1.5 truncate text-[11px] text-muted">{tile.hint}</p> : null}
    </>
  );

  const className = cx(
    "block rounded-xl border bg-surface px-3 py-3 shadow-[var(--shadow-card)] transition-colors",
    tile.emphasis ? "border-danger/40" : "border-border-base",
    tile.href && "hover:border-accent/50",
  );

  if (!tile.href) return <div className={className}>{body}</div>;
  return (
    <Link href={tile.href} className={className}>
      {body}
    </Link>
  );
}

/**
 * Connection state for the push stream.
 *
 * Shown rather than hidden: if the stream has dropped, every number on screen
 * is frozen at whatever it was when the connection died, and an operator has to
 * be able to tell that from a genuinely quiet fleet.
 */
export function StreamIndicator() {
  const { streamState, lastEventAt, now } = useStreamStatus();

  const label =
    streamState === "live" ? "Live" : streamState === "connecting" ? "Connecting" : "Reconnecting";
  const tone = streamState === "live" ? "ok" : streamState === "connecting" ? "warn" : "danger";

  return (
    <span
      className="inline-flex items-center gap-2 rounded-lg border border-border-base bg-surface px-2.5 py-1.5 text-xs"
      title={lastEventAt ? `Last update ${formatAge(now - lastEventAt)}` : "No updates received yet"}
    >
      <Dot tone={tone} pulse={streamState === "live"} />
      <span className="font-medium">{label}</span>
      {lastEventAt ? (
        <span className="tabular text-muted">{formatAge(now - lastEventAt)}</span>
      ) : null}
    </span>
  );
}
