"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DutyChart,
  TimeSeriesChart,
  TimelineStrip,
  type ChartBand,
  type Series,
  type TimelineSpan,
} from "./charts";
import { useLiveDevice, useLiveFeed, useNow } from "./live-store";
import {
  ChannelKindBadge,
  ConnectivityBadge,
  SignalMeter,
  FaultBadge,
  HeatLevelBadge,
  SeverityBadge,
  StaleMarker,
  StatusBadge,
  TrippedBadge,
} from "./status";
import { Badge, Card, CardHeader, EmptyState, Field, cx } from "./ui/primitives";
import {
  SIGNAL_LABEL,
  SIGNAL_REASON_LABEL,
  WIFI_MODE_LABEL,
  formatRssi,
  formatAge,
  formatAuditAction,
  formatClock,
  formatCurrent,
  formatDateTime,
  formatDuration,
  formatEnergy,
  formatPercent,
  formatPower,
  formatTemp,
  formatUptime,
  formatVoltage,
} from "@/lib/format";
import type {
  AuditEntry,
  DeviceAlert,
  DeviceCommand,
  DeviceView,
  EnergyBucket,
} from "@/lib/types";

/**
 * The device detail page.
 *
 * Live state comes from the SSE mirror so the header and cards move on their
 * own; history is fetched per range because a month of telemetry has no business
 * being pushed to every connected browser.
 */

// Chart colours are pulled from the same tokens the badges use, so a series and
// its badge cannot drift apart.
const COLOURS = {
  probe1: "#e05a10",
  probe2: "#d32f2f",
  probe3: "#0e7490",
  probe4: "#7c3aed",
  dht: "#1d4ed8",
  limit: "#b3181f",
  power: "#e05a10",
  current: "#1d4ed8",
  humidity: "#0e7490",
  online: "#15803d",
  offline: "#b91c1c",
};

interface HistoryPoint {
  t: number;
  level: string;
  levelValue: number;
  tripped: boolean;
  climate: boolean;
  climateTargetC: number | null;
  totalCurrentA: number;
  totalPowerW: number;
  mainsVoltageV: number;
  temp1C: number | null;
  temp2C: number | null;
  temp3C: number | null;
  temp4C: number | null;
  dhtTempC: number | null;
  avgTempC: number | null;
  maxTempC: number | null;
  humidity1Pct: number | null;
  humidity2Pct: number | null;
  humidity3Pct: number | null;
  temperatureLimitC: number | null;
  wifi: "AP" | "STA";
  bluetoothClient: boolean;
  uptimeSeconds: number;
}

interface ChannelPoint {
  t: number;
  channelIndex: number;
  channelId: string;
  isOn: boolean;
  currentA: number;
  powerW: number;
  fault: string;
}

/** A gap in reporting, as returned by the history endpoint. */
interface HistoryOutage {
  /** The board's last frame before it went quiet; null if it predates the window. */
  lastSeenAt: number | null;
  /** First frame after the gap; null while the outage is still running. */
  backAt: number | null;
  from: number;
  to: number | null;
}

export interface HistoryPayload {
  range: string;
  from: number;
  to: number;
  /** When the server built this payload; bounds the "so far" part of a window that ends in the future. */
  generatedAt: number;
  outages: HistoryOutage[];
  telemetry: HistoryPoint[];
  channels: ChannelPoint[];
  energy: EnergyBucket[];
  alerts: DeviceAlert[];
}

const RANGES = [
  { key: "today", label: "Today" },
  { key: "24h", label: "24 h" },
  { key: "7d", label: "7 d" },
  { key: "30d", label: "30 d" },
] as const;

export function DeviceDetail({
  device: initialDevice,
  alerts: initialAlerts,
  commands: initialCommands,
  audit,
  history: initialHistory,
}: {
  device: DeviceView;
  alerts: DeviceAlert[];
  commands: DeviceCommand[];
  audit: AuditEntry[];
  history: HistoryPayload;
}) {
  const device = useLiveDevice(initialDevice);
  const now = useNow();

  const [range, setRange] = useState<string>(initialHistory.range);
  const [history, setHistory] = useState<HistoryPayload>(initialHistory);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(
    async (nextRange: string) => {
      setLoading(true);
      setHistoryError(null);
      try {
        const response = await fetch(`/api/devices/${device.id}/history?range=${nextRange}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`History request failed (${response.status})`);
        setHistory((await response.json()) as HistoryPayload);
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : "Could not load history");
      } finally {
        setLoading(false);
      }
    },
    [device.id],
  );

  const changeRange = (nextRange: string) => {
    setRange(nextRange);
    void loadHistory(nextRange);
  };

  // A board going offline or coming back changes the outage list, so refetch
  // the window rather than let the downtime figures drift from the header.
  const lastOnline = useRef(device.online);
  useEffect(() => {
    if (lastOnline.current === device.online) return;
    lastOnline.current = device.online;
    void loadHistory(range);
  }, [device.online, loadHistory, range]);

  const frame = device.telemetry;
  const age = device.lastSeenAt === null ? null : now - device.lastSeenAt;

  return (
    <div className="space-y-4">
      <DetailHeader device={device} age={age} />

      <div className="grid gap-4 lg:grid-cols-3">
        <LiveStatusCard device={device} age={age} />
        <ElectricalCard device={device} />
        <ClimateCard device={device} />
      </div>

      <ChannelsCard device={device} />

      <div className="grid gap-4 lg:grid-cols-3">
        <IdentityCard device={device} />
        <ConnectivityCard device={device} />
        <ProtectionCard device={device} />
      </div>

      <HistorySection
        device={device}
        history={history}
        range={range}
        loading={loading}
        error={historyError}
        onRangeChange={changeRange}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <AlertsCard device={device} initial={initialAlerts} now={now} />
        <CommandsCard device={device} initial={initialCommands} now={now} />
      </div>

      <AuditCard entries={audit} />

      {frame?.raw ? <RawFrameCard raw={frame.raw} recordedAt={frame.recordedAt} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------- header

function DetailHeader({ device, age }: { device: DeviceView; age: number | null }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <nav className="text-xs text-muted">
          <Link href="/devices" className="hover:text-accent">
            Devices
          </Link>
          <span aria-hidden> / </span>
          <span>{device.name}</span>
        </nav>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">{device.name}</h1>
        <p className="mt-0.5 text-sm text-muted">
          {[device.roomName, device.homeName, device.model].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {device.tripped ? <TrippedBadge /> : null}
        {device.online && device.stale ? <StaleMarker ageMs={age} /> : null}
        <ConnectivityBadge device={device} />
        <StatusBadge device={device} />
      </div>
    </header>
  );
}

// -------------------------------------------------------------- state cards

function LiveStatusCard({ device, age }: { device: DeviceView; age: number | null }) {
  const frame = device.telemetry;

  return (
    <Card>
      <CardHeader
        title="Now"
        description={
          device.online
            ? `Updated ${formatAge(age)}`
            : device.lastSeenAt !== null && age !== null
              ? `Offline since ${formatDateTime(device.lastSeenAt)} · down ${formatDuration(age)}`
              : "Offline · never reported"
        }
      />
      <div className="px-4 py-3.5 sm:px-5">
        {!frame ? (
          <p className="text-sm text-muted">This device has never reported.</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span
                className={cx(
                  "tabular text-4xl font-semibold leading-none",
                  device.online ? "text-foreground" : "text-muted",
                )}
              >
                {device.online && device.hottestTempC !== null
                  ? formatTemp(device.hottestTempC)
                  : "—"}
              </span>
              <span className="text-xs text-muted">hottest probe</span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <HeatLevelBadge level={frame.level} muted={!device.online} />
              {frame.climate ? <Badge tone="wifi">Climate</Badge> : null}
              {frame.manual ? <Badge tone="neutral">Manual</Badge> : null}
              {frame.autoFan ? <Badge tone="neutral">Auto fan</Badge> : null}
              <Badge tone="neutral">{frame.mode}</Badge>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3">
              <Field
                label="Humidity"
                value={device.online ? formatPercent(device.averageHumidityPct, 1) : "—"}
              />
              <Field
                label="Board uptime"
                value={formatUptime(frame.uptimeSeconds)}
                hint="Time since the board last powered on, as of its last report"
              />
            </dl>
          </>
        )}
      </div>
    </Card>
  );
}

function ElectricalCard({ device }: { device: DeviceView }) {
  const frame = device.telemetry;
  const live = device.online && frame !== null;

  return (
    <Card>
      <CardHeader
        title="Electrical"
        description={frame ? `Source: ${frame.readingSource}` : "No readings"}
      />
      <div className="px-4 py-3.5 sm:px-5">
        <div className="flex items-baseline gap-2">
          <span
            className={cx(
              "tabular text-4xl font-semibold leading-none",
              live && frame.totalPowerW > 0 ? "text-heat" : "text-muted",
            )}
          >
            {live ? formatPower(frame.totalPowerW) : "—"}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Total current" value={live ? formatCurrent(frame.totalCurrentA) : "—"} />
          <Field label="Channel sum" value={live ? formatCurrent(frame.sumCurrentA) : "—"} />
          <Field label="Mains" value={live ? formatVoltage(frame.mainsVoltageV) : "—"} />
          <Field
            label="Meter"
            value={live && frame.meterVoltageV > 0 ? formatVoltage(frame.meterVoltageV) : "—"}
          />
        </dl>
      </div>
    </Card>
  );
}

function ClimateCard({ device }: { device: DeviceView }) {
  const frame = device.telemetry;
  const live = device.online && frame !== null;

  return (
    <Card>
      <CardHeader title="Temperature probes" description="Up to four probes plus the DHT sensor" />
      <div className="px-4 py-3.5 sm:px-5">
        <dl className="grid grid-cols-2 gap-3">
          <Field label="Probe 1" value={live ? formatTemp(frame.temp1C) : "—"} />
          <Field label="Probe 2" value={live ? formatTemp(frame.temp2C) : "—"} />
          <Field label="Probe 3" value={live ? formatTemp(frame.temp3C) : "—"} />
          <Field label="Probe 4" value={live ? formatTemp(frame.temp4C) : "—"} />
          <Field label="DHT" value={live ? formatTemp(frame.dhtTempC) : "—"} />
          <Field label="Average" value={live ? formatTemp(frame.avgTempC) : "—"} />
          <Field label="Humidity 1" value={live ? formatPercent(frame.humidity1Pct, 1) : "—"} />
          <Field label="Humidity 2" value={live ? formatPercent(frame.humidity2Pct, 1) : "—"} />
          <Field label="Humidity 3" value={live ? formatPercent(frame.humidity3Pct, 1) : "—"} />
          <Field
            label="Climate target"
            value={live && frame.climate ? formatTemp(frame.climateTargetC) : "—"}
          />
        </dl>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ channels

function ChannelsCard({ device }: { device: DeviceView }) {
  return (
    <Card>
      <CardHeader
        title="Channels"
        description="Every relay on the board, with its CT reading and fault state"
      />
      {device.channels.length === 0 ? (
        <EmptyState
          title="No channels configured"
          description="This device has no rows in device_channels."
        />
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border-base text-left">
                {["Channel", "Type", "State", "Current", "Power", "Energy", "Fault", "Pins"].map(
                  (heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className={cx(
                        "px-4 py-2 text-[11px] font-medium tracking-wide text-muted uppercase",
                        ["Current", "Power", "Energy"].includes(heading) && "text-right",
                      )}
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {device.channels.map((channel) => {
                const reading = channel.reading;
                const live = device.online && reading !== null;
                return (
                  <tr key={channel.channelIndex} className="border-b border-border-base last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{channel.name}</span>
                      <p className="font-mono mt-0.5 text-[11px] text-muted">
                        {channel.channelId} · index {channel.channelIndex}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <ChannelKindBadge kind={channel.kind} />
                    </td>
                    <td className="px-4 py-2.5">
                      {!channel.enabled ? (
                        <Badge tone="neutral">Disabled</Badge>
                      ) : live && reading.isOn ? (
                        <Badge tone="heat">On</Badge>
                      ) : live ? (
                        <Badge tone="neutral">Off</Badge>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {live ? formatCurrent(reading.currentA) : "—"}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {live ? formatPower(reading.powerW) : "—"}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right text-muted">
                      {live ? formatEnergy(reading.energyWh) : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      {reading ? <FaultBadge fault={reading.fault} /> : <span className="text-muted">—</span>}
                    </td>
                    <td className="font-mono px-4 py-2.5 text-[11px] text-muted">
                      relay {channel.relayPin ?? "—"} · CT {channel.ctPin ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------- static cards

function IdentityCard({ device }: { device: DeviceView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetPairing = async () => {
    if (
      !window.confirm(
        "Forget this device's key? The board currently paired will stop being accepted, and the next board with this serial will pair instead.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/devices/${device.id}/pairing`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? `Request failed (${response.status})`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Identity"
        actions={
          <button
            type="button"
            onClick={() => void resetPairing()}
            disabled={busy || !device.paired}
            title={
              device.paired
                ? "Let a replacement or re-flashed board take over this device"
                : "No key issued yet - the board will pair on its own"
            }
            className="rounded-lg border border-border-base px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 enabled:hover:border-accent/50"
          >
            {busy ? "Resetting…" : "Reset pairing"}
          </button>
        }
      />
      <dl className="grid grid-cols-2 gap-3 px-4 py-3.5 sm:px-5">
        <Field label="Serial" value={device.serialNumber ?? "—"} mono />
        <Field
          label="Pairing"
          value={
            device.paired ? (
              <span title={formatDateTime(device.pairedAt)}>Paired {formatDateTime(device.pairedAt)}</span>
            ) : (
              <Badge tone="warn">Waiting for board</Badge>
            )
          }
          hint={
            device.paired
              ? "The board holds a device key and can post telemetry"
              : "Added on the portal; pairs when the board with this serial reaches the server"
          }
        />
        <Field label="Model" value={device.model} />
        <Field label="Firmware" value={device.firmwareVersion ?? "—"} mono />
        <Field label="Room" value={device.roomName ?? "Unassigned"} />
        <Field label="Home" value={device.homeName} />
        <Field label="Registered" value={formatDateTime(device.createdAt)} />
        <Field label="Device id" value={device.id} mono hint={device.id} />
      </dl>
      {error ? <p className="px-4 pb-3 text-xs text-danger sm:px-5">{error}</p> : null}
    </Card>
  );
}

function ConnectivityCard({ device }: { device: DeviceView }) {
  const frame = device.telemetry;

  return (
    <Card>
      <CardHeader title="Connectivity" description="As the board reports it" />
      <dl className="grid grid-cols-2 gap-3 px-4 py-3.5 sm:px-5">
        <Field label="Signal" value={<SignalMeter device={device} showValue />} />
        <Field
          label="Signal quality"
          value={
            device.signal.quality === null
              ? device.signal.reason
                ? SIGNAL_REASON_LABEL[device.signal.reason]
                : "—"
              : device.signal.percent === null
                ? SIGNAL_LABEL[device.signal.quality]
                : `${SIGNAL_LABEL[device.signal.quality]} · ${device.signal.percent}%`
          }
        />
        <Field label="Wi-Fi RSSI" value={formatRssi(frame?.rssiDbm)} />
        <Field label="Bluetooth RSSI" value={formatRssi(frame?.bleRssiDbm)} />
        <Field label="Wi-Fi mode" value={frame ? WIFI_MODE_LABEL[frame.wifi] : "—"} />
        <Field label="IP address" value={frame?.ip ?? "—"} mono />
        <Field label="Home SSID" value={device.homeSsid ?? "—"} />
        <Field label="Local address" value={device.localAddress ?? "—"} mono />
        <Field
          label="Bluetooth"
          value={frame ? (frame.bluetoothClient ? "Client connected" : "No client") : "—"}
        />
        <Field label="BLE name" value={device.bluetoothName} mono />
        <Field label="Last seen" value={formatDateTime(device.lastSeenAt)} />
        <Field label="API key" value={frame ? (frame.apiKeySet ? "Set" : "Not set") : "—"} />
      </dl>
    </Card>
  );
}

function ProtectionCard({ device }: { device: DeviceView }) {
  const settings = device.settings;
  const frame = device.telemetry;

  return (
    <Card>
      <CardHeader
        title="Protection limits"
        description="What the ingest layer measures each frame against"
      />
      <dl className="grid grid-cols-2 gap-3 px-4 py-3.5 sm:px-5">
        <Field
          label="Per-channel limit"
          value={settings ? formatCurrent(settings.currentLimitA, 1) : "—"}
        />
        <Field label="Total limit" value={settings ? formatCurrent(settings.totalLimitA, 1) : "—"} />
        <Field
          label="Temperature limit"
          value={settings ? formatTemp(settings.temperatureLimitC) : "—"}
        />
        <Field label="Mains" value={settings ? formatVoltage(settings.mainsVoltageV) : "—"} />
        <Field label="Auto fan" value={settings ? (settings.autoFan ? "On" : "Off") : "—"} />
        <Field
          label="Climate"
          value={
            settings
              ? settings.climateEnabled
                ? `On · ${formatTemp(settings.climateTargetC)}`
                : "Off"
              : "—"
          }
        />
      </dl>
      {frame?.tripped ? (
        <p className="mx-4 mb-3.5 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger sm:mx-5">
          Protection is tripped. The board has cut power and stays latched until it is reset.
        </p>
      ) : null}
    </Card>
  );
}

// -------------------------------------------------------------------- charts

function HistorySection({
  device,
  history,
  range,
  loading,
  error,
  onRangeChange,
}: {
  device: DeviceView;
  history: HistoryPayload;
  range: string;
  loading: boolean;
  error: string | null;
  onRangeChange: (range: string) => void;
}) {
  const now = useNow();
  const span = history.to - history.from;

  // The window may end in the future ("today" runs to midnight), so the part
  // with anything to say ends at the clock, rounded so the memos below do not
  // rebuild every second.
  const cutoff = Math.min(history.to, Math.max(history.generatedAt, Math.floor(now / 30_000) * 30_000));

  // Outages clamped to what has elapsed; an open one runs to the clock.
  const outages = useMemo(
    () =>
      history.outages
        .map((o) => ({ from: Math.max(o.from, history.from), to: Math.min(o.to ?? cutoff, cutoff) }))
        .filter((o) => o.to > o.from),
    [history.outages, history.from, cutoff],
  );

  /**
   * A fixed grid of sample instants across the elapsed window. Each bucket
   * carries the latest frame up to its end, or is flagged offline when it
   * falls inside an outage, so the charts cover the whole range and read 0
   * while the board was silent instead of ending at the last frame.
   */
  const timeline = useMemo(() => {
    const stepMs = Math.max(15_000, Math.ceil(span / 720 / 1000) * 1000);
    const timestamps: number[] = [];
    const points: Array<HistoryPoint | null> = [];
    const states: Array<"online" | "offline" | "unknown"> = [];
    const frames = history.telemetry;
    let ptr = -1;
    let outageIndex = 0;
    for (let t = history.from; t <= cutoff; t += stepMs) {
      while (ptr + 1 < frames.length && frames[ptr + 1].t <= t + stepMs) ptr += 1;
      while (outageIndex < outages.length && outages[outageIndex].to <= t) outageIndex += 1;
      const outage = outages[outageIndex];
      const offline = outage !== undefined && outage.from < t && t < outage.to;
      timestamps.push(t);
      if (offline) {
        points.push(null);
        states.push("offline");
      } else if (ptr >= 0) {
        points.push(frames[ptr]);
        states.push("online");
      } else {
        points.push(null);
        states.push("unknown");
      }
    }
    return { stepMs, timestamps, points, states };
  }, [history.telemetry, history.from, cutoff, span, outages]);

  const timestamps = timeline.timestamps;

  const bands: ChartBand[] = useMemo(
    () => outages.map((o) => ({ ...o, label: "Offline", colour: COLOURS.offline })),
    [outages],
  );
  const states = useMemo(
    () => timeline.states.map((state) => (state === "offline" ? "Offline — board not reporting" : null)),
    [timeline.states],
  );

  const sample = useCallback(
    (get: (point: HistoryPoint) => number | null, offlineValue: number | null = 0) =>
      timeline.points.map((point, index) =>
        timeline.states[index] === "offline" ? offlineValue : point ? get(point) : null,
      ),
    [timeline],
  );

  const tempSeries: Series[] = useMemo(
    () => [
      { key: "temp1", label: "Probe 1", colour: COLOURS.probe1, values: sample((p) => p.temp1C), unit: "°C", decimals: 1 },
      { key: "temp2", label: "Probe 2", colour: COLOURS.probe2, values: sample((p) => p.temp2C), unit: "°C", decimals: 1 },
      { key: "temp3", label: "Probe 3", colour: COLOURS.probe3, values: sample((p) => p.temp3C), unit: "°C", decimals: 1 },
      { key: "temp4", label: "Probe 4", colour: COLOURS.probe4, values: sample((p) => p.temp4C), unit: "°C", decimals: 1 },
      { key: "dht", label: "DHT", colour: COLOURS.dht, values: sample((p) => p.dhtTempC), unit: "°C", decimals: 1 },
      {
        key: "limit",
        label: "Limit",
        colour: COLOURS.limit,
        values: sample((p) => p.temperatureLimitC, null),
        dashed: true,
        unit: "°C",
        decimals: 0,
      },
    ],
    [sample],
  );

  const powerSeries: Series[] = useMemo(
    () => [
      { key: "power", label: "Total power", colour: COLOURS.power, values: sample((p) => p.totalPowerW), unit: "W", decimals: 0 },
    ],
    [sample],
  );

  const currentSeries: Series[] = useMemo(
    () => [
      { key: "current", label: "Total current", colour: COLOURS.current, values: sample((p) => p.totalCurrentA), unit: "A", decimals: 2 },
    ],
    [sample],
  );

  const humiditySeries: Series[] = useMemo(
    () => [
      { key: "h1", label: "Humidity 1", colour: COLOURS.humidity, values: sample((p) => p.humidity1Pct), unit: "%", decimals: 1 },
      { key: "h2", label: "Humidity 2", colour: COLOURS.dht, values: sample((p) => p.humidity2Pct), unit: "%", decimals: 1 },
      { key: "h3", label: "Humidity 3", colour: COLOURS.probe1, values: sample((p) => p.humidity3Pct), unit: "%", decimals: 1 },
    ],
    [sample],
  );

  // Duty is the share of the level range the board was calling for, which is a
  // more honest picture than an on/off line when the unit cycles quickly.
  const duty = useMemo(() => sample((p) => (p.levelValue / 3) * 100), [sample]);

  // Connectivity timeline: contiguous runs of the same Wi-Fi mode become spans,
  // so a pattern of AP-mode fallbacks is visible at a glance. A run is broken
  // at every outage so the mode is not painted across time with no frames.
  const linkSpans: TimelineSpan[] = useMemo(() => {
    const restarts = new Set(history.outages.map((o) => o.backAt));
    const spans: TimelineSpan[] = [];
    for (const point of history.telemetry) {
      const label = point.wifi === "STA" ? "Home Wi-Fi" : "AP mode";
      const colour = point.wifi === "STA" ? "#0e7490" : "#b45309";
      const last = spans[spans.length - 1];
      if (last && last.label === label && !restarts.has(point.t)) last.to = point.t;
      else spans.push({ from: point.t, to: point.t, label, colour });
    }
    return spans;
  }, [history.telemetry, history.outages]);

  // Availability: the elapsed window split into online and offline runs, plus
  // the totals the card prints.
  const availability = useMemo(() => {
    const observed = Math.max(cutoff - history.from, 0);
    const downtime = outages.reduce((sum, o) => sum + (o.to - o.from), 0);
    const known = history.telemetry.length > 0 || history.outages.length > 0;
    const spans: TimelineSpan[] = [];
    if (known) {
      let cursor = history.from;
      for (const o of outages) {
        if (o.from > cursor) spans.push({ from: cursor, to: o.from, label: "Online", colour: COLOURS.online });
        spans.push({ from: o.from, to: o.to, label: "Offline", colour: COLOURS.offline });
        cursor = o.to;
      }
      if (cutoff > cursor) spans.push({ from: cursor, to: cutoff, label: "Online", colour: COLOURS.online });
    }
    return {
      known,
      observed,
      downtime,
      uptimePct: known && observed > 0 ? ((observed - downtime) / observed) * 100 : null,
      spans,
      ongoing: history.outages.some((o) => o.to === null),
    };
  }, [history.from, history.telemetry.length, history.outages, outages, cutoff]);

  const energyByChannel = useMemo(() => {
    const totals = new Map<string, { name: string; energyWh: number; peakPowerW: number }>();
    for (const bucket of history.energy) {
      const channel = device.channels.find((c) => c.channelIndex === bucket.channelIndex);
      const name = channel?.name ?? bucket.channelId;
      const entry = totals.get(name) ?? { name, energyWh: 0, peakPowerW: 0 };
      entry.energyWh += bucket.energyWh;
      entry.peakPowerW = Math.max(entry.peakPowerW, bucket.peakPowerW);
      totals.set(name, entry);
    }
    return [...totals.values()].sort((a, b) => b.energyWh - a.energyWh);
  }, [history.energy, device.channels]);

  const peakEnergy = Math.max(1, ...energyByChannel.map((entry) => entry.energyWh));

  return (
    <Card>
      <CardHeader
        title="History"
        description={
          loading
            ? "Loading…"
            : `${history.telemetry.length} readings · ${formatDateTime(history.from)} → ${formatDateTime(history.to)}`
        }
        actions={
          <div className="flex gap-1">
            {RANGES.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => onRangeChange(option.key)}
                aria-pressed={range === option.key}
                className={cx(
                  "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                  range === option.key
                    ? "bg-accent-soft text-accent"
                    : "text-muted-strong hover:bg-surface-muted",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      />

      {error ? (
        <p className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-xs text-danger sm:px-5">
          {error}
        </p>
      ) : null}

      <div className="space-y-6 px-4 py-4 sm:px-5">
        <ChartBlock
          title="Availability"
          hint={
            availability.known
              ? `${availability.uptimePct === null ? "—" : `${availability.uptimePct.toFixed(1)}%`} online · downtime ${formatDuration(availability.downtime)} · ${history.outages.length} ${history.outages.length === 1 ? "outage" : "outages"}${availability.ongoing ? " · still offline" : ""}`
              : "No frames in this range"
          }
        >
          <TimelineStrip
            spans={availability.spans}
            from={history.from}
            to={history.to}
            emptyMessage="No data in this range"
          />
          {history.outages.length > 0 ? (
            <ul className="mt-3 divide-y divide-border-base rounded-lg border border-border-base text-xs">
              {history.outages.map((outage, index) => {
                const start = outage.lastSeenAt ?? outage.from;
                const end = outage.backAt ?? outage.to ?? cutoff;
                return (
                  <li key={`${outage.from}-${index}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block size-2 rounded-full" style={{ background: COLOURS.offline }} />
                      <span className="text-muted">Went offline</span>
                      <span className="tabular font-medium">
                        {outage.lastSeenAt === null ? `before ${formatDateTime(outage.from)}` : formatDateTime(outage.lastSeenAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-muted">Back online</span>
                      <span className="tabular font-medium">
                        {outage.backAt !== null
                          ? formatDateTime(outage.backAt)
                          : outage.to === null
                            ? "still offline"
                            : `not by ${formatDateTime(outage.to)}`}
                      </span>
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      <span className="text-muted">Downtime</span>
                      <span className={cx("tabular font-medium", outage.to === null && "text-danger")}>
                        {formatDuration(end - start)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </ChartBlock>

        <ChartBlock title="Temperature probes vs. limit">
          <TimeSeriesChart
            timestamps={timestamps}
            series={tempSeries}
            height={220}
            yLabel="°C"
            from={history.from}
            to={history.to}
            bands={bands}
            states={states}
          />
        </ChartBlock>

        <div className="grid gap-6 xl:grid-cols-2">
          <ChartBlock title="Total power">
            <TimeSeriesChart
              timestamps={timestamps}
              series={powerSeries}
              height={180}
              yLabel="W"
              yMin={0}
              from={history.from}
              to={history.to}
              bands={bands}
              states={states}
            />
          </ChartBlock>
          <ChartBlock title="Total current">
            <TimeSeriesChart
              timestamps={timestamps}
              series={currentSeries}
              height={180}
              yLabel="A"
              yMin={0}
              from={history.from}
              to={history.to}
              bands={bands}
              states={states}
            />
          </ChartBlock>
        </div>

        <ChartBlock title="Heat demand" hint="Share of full output the board was calling for">
          <DutyChart
            timestamps={timestamps}
            duty={duty}
            from={history.from}
            to={history.to}
            stepMs={timeline.stepMs}
            bands={bands}
          />
        </ChartBlock>

        <ChartBlock title="Humidity">
          <TimeSeriesChart
            timestamps={timestamps}
            series={humiditySeries}
            height={160}
            yLabel="%"
            yMin={0}
            yMax={100}
            from={history.from}
            to={history.to}
            bands={bands}
            states={states}
          />
        </ChartBlock>

        <ChartBlock title="Wi-Fi mode over the window">
          <TimelineStrip spans={linkSpans} from={history.from} to={history.to} />
        </ChartBlock>

        <ChartBlock title="Energy by channel" hint="From the hourly rollup in energy_hourly">
          {energyByChannel.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-base px-3 py-6 text-center text-xs text-muted">
              No energy recorded in this range
            </p>
          ) : (
            <ul className="space-y-2">
              {energyByChannel.map((entry) => (
                <li key={entry.name}>
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-medium">{entry.name}</span>
                    <span className="tabular text-muted">
                      {formatEnergy(entry.energyWh)} · peak {formatPower(entry.peakPowerW)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className="h-full rounded-full bg-heat"
                      style={{ width: `${(entry.energyWh / peakEnergy) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ChartBlock>

        {span > 0 ? null : null}
      </div>
    </Card>
  );
}

function ChartBlock({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold tracking-wide text-muted-strong uppercase">{title}</h3>
      {hint ? <p className="mt-0.5 mb-2 text-[11px] text-muted">{hint}</p> : <div className="mb-2" />}
      {children}
    </section>
  );
}

// ------------------------------------------------------------------- tables

function AlertsCard({
  device,
  initial,
  now,
}: {
  device: DeviceView;
  initial: DeviceAlert[];
  now: number;
}) {
  const deviceId = device.id;
  const [alerts, setAlerts] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  // The heater raising or clearing a fault changes this device's open-alert
  // count on every frame the live stream already delivers (useLiveDevice), so
  // that count is the cheapest reliable signal the list below is stale - no
  // separate subscription needed, and it fires the instant the SSE patch for
  // this device lands.
  const alertSignature = `${device.openAlertCount}:${device.worstAlertSeverity ?? ""}`;
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/devices/${deviceId}/alerts?limit=50`, { cache: "no-store" });
      if (cancelled || !response.ok) return;
      const body = (await response.json()) as { alerts: DeviceAlert[] };
      if (!cancelled) setAlerts(body.alerts);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertSignature]);

  const acknowledge = async (alertId: string) => {
    setBusy(alertId);
    try {
      const response = await fetch(`/api/devices/${deviceId}/alerts`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alertId }),
      });
      if (response.ok) {
        setAlerts((previous) =>
          previous.map((alert) =>
            alert.id === alertId ? { ...alert, acknowledgedAt: Date.now() } : alert,
          ),
        );
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Alerts"
        description="Cleared automatically when the condition stops appearing in a frame"
      />
      {alerts.length === 0 ? (
        <EmptyState title="No alerts recorded" />
      ) : (
        <ul className="max-h-96 divide-y divide-border-base overflow-y-auto">
          {alerts.map((alert) => (
            <li key={alert.id} className="px-4 py-2.5 sm:px-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{alert.message}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    <span className="font-mono">{alert.code}</span>
                    {alert.channelId ? ` · ${alert.channelId}` : ""} · raised{" "}
                    {formatAge(now - alert.raisedAt)}
                    {alert.clearedAt ? ` · cleared ${formatClock(alert.clearedAt)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <SeverityBadge severity={alert.severity} />
                  {alert.clearedAt ? (
                    <Badge tone="ok">Cleared</Badge>
                  ) : alert.acknowledgedAt ? (
                    <Badge tone="neutral">Acknowledged</Badge>
                  ) : (
                    <button
                      type="button"
                      onClick={() => acknowledge(alert.id)}
                      disabled={busy === alert.id}
                      className="rounded-lg border border-border-base px-2 py-1 text-[11px] font-medium hover:border-accent/50 disabled:opacity-50"
                    >
                      {busy === alert.id ? "…" : "Acknowledge"}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const COMMAND_TONE = {
  pending: "warn",
  delivered: "wifi",
  acked: "ok",
  failed: "danger",
  expired: "neutral",
} as const;

function CommandsCard({
  device,
  initial,
  now,
}: {
  device: DeviceView;
  initial: DeviceCommand[];
  now: number;
}) {
  const deviceId = device.id;
  const online = device.online;
  const feed = useLiveFeed();
  const [commands, setCommands] = useState(initial);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/devices/${deviceId}/commands?limit=25`, {
      cache: "no-store",
    });
    if (response.ok) {
      const body = (await response.json()) as { commands: DeviceCommand[] };
      setCommands(body.commands);
    }
  }, [deviceId]);

  // Queuing a command and the board acking or failing one both publish a
  // "command" entry on the live feed for this device, so react to that the
  // instant it arrives. A command can also silently change status - marked
  // "delivered" the moment the board claims it on an ordinary telemetry
  // frame, which is deliberately too noisy to appear in the feed - so a slow
  // timer stays as the fallback for whatever the push channel misses.
  const latestCommandEvent = feed.find((entry) => entry.deviceId === deviceId && entry.reason === "command");
  useEffect(() => {
    if (!latestCommandEvent) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/devices/${deviceId}/commands?limit=25`, { cache: "no-store" });
      if (cancelled || !response.ok) return;
      const body = (await response.json()) as { commands: DeviceCommand[] };
      if (!cancelled) setCommands(body.commands);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestCommandEvent?.id]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const command = draft.trim();
    if (!command) return;

    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/devices/${deviceId}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }
      setDraft("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue the command");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Commands"
        description="Queued here, collected by the board on its next round trip"
      />

      <form onSubmit={submit} className="flex flex-wrap gap-2 border-b border-border-base px-4 py-3 sm:px-5">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="e.g. SET LEVEL HIGH"
          aria-label="Command to queue"
          className="min-w-0 flex-1 rounded-lg border border-border-base bg-surface px-3 py-2 font-mono text-xs placeholder:text-muted placeholder:font-sans"
        />
        <button
          type="submit"
          disabled={sending || draft.trim() === ""}
          className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {sending ? "Queueing…" : "Queue"}
        </button>
      </form>

      {error ? (
        <p className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-xs text-danger sm:px-5">
          {error}
        </p>
      ) : null}

      {!online ? (
        <p className="border-b border-warn/30 bg-warn-soft px-4 py-2 text-xs text-warn sm:px-5">
          This device is offline. The command will be waiting when it reconnects, or expire first.
        </p>
      ) : null}

      {commands.length === 0 ? (
        <EmptyState title="No commands issued" />
      ) : (
        <ul className="max-h-72 divide-y divide-border-base overflow-y-auto">
          {commands.map((command) => (
            <li key={command.id} className="flex items-start justify-between gap-3 px-4 py-2 sm:px-5">
              <div className="min-w-0 flex-1">
                <p className="font-mono truncate text-xs">{command.command}</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {formatAge(now - command.createdAt)}
                  {command.reply ? ` · ${command.reply}` : ""}
                  {command.error ? ` · ${command.error}` : ""}
                </p>
              </div>
              <Badge tone={COMMAND_TONE[command.status]}>{command.status}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AuditCard({ entries }: { entries: AuditEntry[] }) {
  return (
    <Card>
      <CardHeader title="Audit trail" description="Configuration changes recorded against this device" />
      {entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet" />
      ) : (
        <ul className="divide-y divide-border-base">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-2 sm:px-5">
              <div className="min-w-0">
                <p className="text-xs font-medium">{formatAuditAction(entry.action)}</p>
                {entry.detail ? (
                  <p className="font-mono mt-0.5 truncate text-[11px] text-muted">
                    {JSON.stringify(entry.detail)}
                  </p>
                ) : null}
              </div>
              <span className="tabular shrink-0 text-[11px] text-muted">
                {formatDateTime(entry.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The exact JSON the board last sent.
 *
 * Kept because when a reading looks wrong the first question is always whether
 * the device sent it that way or the backend mangled it, and this settles it
 * without going to the database.
 */
function RawFrameCard({
  raw,
  recordedAt,
}: {
  raw: Record<string, unknown>;
  recordedAt: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader
        title="Last raw frame"
        description={`Exactly as received at ${formatDateTime(recordedAt)}`}
        actions={
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="rounded-lg border border-border-base px-2.5 py-1.5 text-xs font-medium hover:border-accent/50"
          >
            {open ? "Hide" : "Show"}
          </button>
        }
      />
      {open ? (
        <pre className="scroll-x font-mono px-4 py-3 text-[11px] leading-relaxed text-muted-strong sm:px-5">
          {JSON.stringify(raw, null, 2)}
        </pre>
      ) : null}
    </Card>
  );
}
