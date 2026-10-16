"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SensorChart, type SensorSeries, type ThresholdLine } from "./sensor-chart";
import { SensorsOk } from "./sensor-list";
import {
  NO_READING,
  OnlineBadge,
  POLL_INTERVAL_MS,
  SENSOR_COLOUR,
  formatReading,
  liveSignal,
  liveStatus,
  sensorName,
  usePolling,
  useServerNow,
  type ClockSync,
} from "./sensor-shared";
import { SignalMeter } from "./status";
import { Badge, Card, CardHeader, EmptyState, Field, cx } from "./ui/primitives";
import { formatAge, formatClock, formatDateTime, formatRssi, formatUptime } from "@/lib/format";
import {
  DEFAULT_SENSOR_LABEL,
  HUMIDITY_SENSORS,
  SENSOR_KEYS,
  SENSOR_LABEL_MAX_LENGTH,
  TEMP_SENSORS,
  type SensorAlert,
  type SensorDevice,
  type SensorHistory,
  type SensorKey,
  type SensorRange,
  type SensorReading,
  type SensorSettings,
  type SeriesField,
} from "@/lib/sensor-types";

/**
 * The sensor detail page.
 *
 * The newest reading is polled every five seconds and the history a little
 * less often; both are plain fetches, so the page keeps itself current without
 * ever reloading. Everything a tile shows is the value the board sent - a
 * sensor that is not reading is "--", never a zero.
 */

export interface SensorSnapshot {
  sensor: SensorDevice;
  alerts: SensorAlert[];
  serverTime: number;
  offlineTimeoutMs: number;
}

export type SensorHistoryPayload = SensorHistory & { range: SensorRange };

const RANGES: Array<{ key: SensorRange; label: string }> = [
  { key: "1h", label: "1 h" },
  { key: "6h", label: "6 h" },
  { key: "24h", label: "24 h" },
  { key: "7d", label: "7 d" },
];

const HISTORY_REFRESH_MS = 15_000;

/** Which telemetry field carries each sensor's reading. */
const FIELD_OF: Record<SensorKey, SeriesField> = {
  t1: "temp1C",
  t2: "temp2C",
  t3: "temp3C",
  t4: "temp4C",
  h1: "humidity1Pct",
  h2: "humidity2Pct",
};

/** The temperature each humidity sensor measures alongside its humidity. */
const OWN_TEMP_OF: Record<(typeof HUMIDITY_SENSORS)[number], SeriesField> = {
  h1: "dhtTempC",
  h2: "dht2TempC",
};

type Breach = "high" | "low" | null;

function breachOf(value: number | null, high: number | null, low: number | null): Breach {
  if (value === null) return null;
  if (high !== null && value > high) return "high";
  if (low !== null && value < low) return "low";
  return null;
}

export function SensorDetail({
  initial,
  initialHistory,
}: {
  initial: SensorSnapshot;
  initialHistory: SensorHistoryPayload;
}) {
  const id = initial.sensor.id;

  const [snapshot, setSnapshot] = useState(initial);
  const [sync, setSync] = useState<ClockSync | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const [range, setRange] = useState<SensorRange>(initialHistory.range);
  const [history, setHistory] = useState(initialHistory);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const refreshLatest = useCallback(async () => {
    try {
      const response = await fetch(`/api/sensors/${id}/latest`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as SensorSnapshot;
      setSnapshot(body);
      setSync({ serverTime: body.serverTime, receivedAt: Date.now() });
      setRefreshError(null);
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  // Only the newest request may land: a slow 7-day response must not
  // overwrite the 1-hour view the operator has since switched to.
  const historyRequest = useRef(0);
  const rangeRef = useRef(range);

  const loadHistory = useCallback(
    async (nextRange: SensorRange, quiet: boolean) => {
      const request = (historyRequest.current += 1);
      if (!quiet) setHistoryLoading(true);
      try {
        const response = await fetch(`/api/sensors/${id}/history?range=${nextRange}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as SensorHistoryPayload;
        if (request !== historyRequest.current) return;
        setHistory(body);
        setHistoryError(null);
      } catch (cause) {
        if (request !== historyRequest.current) return;
        setHistoryError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request === historyRequest.current) setHistoryLoading(false);
      }
    },
    [id],
  );

  const changeRange = (nextRange: SensorRange) => {
    setRange(nextRange);
    rangeRef.current = nextRange;
    void loadHistory(nextRange, false);
  };

  const refreshAll = useCallback(() => {
    void refreshLatest();
    void loadHistory(rangeRef.current, true);
  }, [refreshLatest, loadHistory]);

  // Held here rather than in the form: saving re-seeds the form from the
  // server's copy, which would take a note kept inside it along with it.
  const [settingsSaved, setSettingsSaved] = useState(false);
  useEffect(() => {
    if (!settingsSaved) return;
    const timer = setTimeout(() => setSettingsSaved(false), 4_000);
    return () => clearTimeout(timer);
  }, [settingsSaved]);

  usePolling(() => void refreshLatest(), POLL_INTERVAL_MS);
  usePolling(() => void loadHistory(rangeRef.current, true), HISTORY_REFRESH_MS);

  const serverNow = useServerNow(sync);
  const { sensor, alerts } = snapshot;
  const status = liveStatus(sensor, serverNow, snapshot.offlineTimeoutMs);

  return (
    <div className="space-y-4">
      <Header sensor={sensor} status={status} refreshError={refreshError} />

      <Readings sensor={sensor} status={status} />

      <HistoryCard
        sensorId={id}
        settings={sensor.settings}
        history={history}
        range={range}
        loading={historyLoading}
        error={historyError}
        onRangeChange={changeRange}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <SettingsCard
          // Re-seeds the form from what the server now holds after a save.
          key={sensor.settings.updatedAt ?? "unset"}
          sensorId={id}
          settings={sensor.settings}
          saved={settingsSaved}
          onSaved={() => {
            setSettingsSaved(true);
            refreshAll();
          }}
        />
        <AlertsCard alerts={alerts} settings={sensor.settings} />
      </div>

      <SimulatorCard sensorId={id} online={status.online} onSent={refreshAll} />
    </div>
  );
}

// --------------------------------------------------------------------- header

function Header({
  sensor,
  status,
  refreshError,
}: {
  sensor: SensorDevice;
  status: ReturnType<typeof liveStatus>;
  refreshError: string | null;
}) {
  const latest = sensor.latest;
  const lastSeen =
    status.ageMs === null
      ? "Never reported"
      : `${formatAge(status.ageMs)} · ${formatClock(sensor.lastSeenAt)}`;

  return (
    <Card>
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <Link href="/sensors" className="text-xs font-medium text-accent hover:underline">
            ← Temperature &amp; Humidity
          </Link>
          <h1 className="mt-1 truncate text-lg font-semibold tracking-tight">{sensor.name}</h1>
          <p className="mt-0.5 font-mono text-xs text-muted">{sensor.serialNumber ?? "No serial"}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {sensor.openAlertCount > 0 ? (
              <Badge tone="danger">
                {sensor.openAlertCount} active alert{sensor.openAlertCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
            <OnlineBadge status={status} />
          </div>
          <span className="tabular text-xs text-muted">
            {status.ageMs === null ? "Never reported" : `Last seen ${formatAge(status.ageMs)}`}
          </span>
        </div>
      </header>

      {refreshError ? (
        <p className="border-t border-warn/30 bg-warn-soft px-4 py-2 text-xs text-warn sm:px-5">
          Could not refresh ({refreshError}) — showing the last data received. Retrying every{" "}
          {POLL_INTERVAL_MS / 1000} s.
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border-base px-4 py-4 sm:grid-cols-3 sm:px-5 lg:grid-cols-5">
        <Field label="Serial" value={sensor.serialNumber ?? NO_READING} mono />
        <Field label="Model" value={sensor.model} />
        <Field label="Firmware" value={sensor.firmwareVersion ?? NO_READING} mono />
        <Field label="IP address" value={latest?.ip ?? NO_READING} mono />
        <Field label="Wi-Fi SSID" value={sensor.homeSsid ?? NO_READING} />
        <Field
          label="Wi-Fi signal"
          value={
            <span className="flex items-center gap-2">
              <SignalMeter device={{ signal: liveSignal(sensor, status.online) }} />
              <span className="tabular text-xs text-muted">{formatRssi(latest?.rssiDbm)}</span>
            </span>
          }
          hint="RSSI as the board last reported it"
        />
        <Field label="Uptime" value={latest ? formatUptime(latest.uptimeSeconds) : NO_READING} />
        <Field label="Last seen" value={lastSeen} hint={formatDateTime(sensor.lastSeenAt)} />
        <Field
          label="Sensors OK"
          value={<SensorsOk ok={latest?.sensorsOk ?? null} total={latest?.sensorsTotal ?? null} />}
        />
        <Field label="Status" value={status.online ? "Online" : "Offline"} />
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------- tiles

function valueOf(latest: SensorReading | null, field: SeriesField): number | null {
  return latest ? latest[field] : null;
}

function Readings({
  sensor,
  status,
}: {
  sensor: SensorDevice;
  status: ReturnType<typeof liveStatus>;
}) {
  const { latest, settings } = sensor;

  return (
    <section aria-label="Current readings" className="space-y-3">
      {!status.online && latest ? (
        <p className="rounded-lg border border-border-base bg-surface-muted px-3 py-2 text-xs text-muted-strong">
          This board is offline. The values below are its last reading, from{" "}
          {formatDateTime(latest.recordedAt)}.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TEMP_SENSORS.map((key) => {
          const value = valueOf(latest, FIELD_OF[key]);
          return (
            <Tile
              key={key}
              sensorKey={key}
              settings={settings}
              value={value}
              unit="°C"
              breach={breachOf(value, settings.tempHighC, settings.tempLowC)}
              high={settings.tempHighC}
              low={settings.tempLowC}
              live={status.online}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {HUMIDITY_SENSORS.map((key) => {
          const value = valueOf(latest, FIELD_OF[key]);
          return (
            <Tile
              key={key}
              sensorKey={key}
              settings={settings}
              value={value}
              unit="%RH"
              breach={breachOf(value, settings.humidityHighPct, settings.humidityLowPct)}
              high={settings.humidityHighPct}
              low={settings.humidityLowPct}
              live={status.online}
              ownTempC={valueOf(latest, OWN_TEMP_OF[key])}
            />
          );
        })}
      </div>
    </section>
  );
}

function Tile({
  sensorKey,
  settings,
  value,
  unit,
  breach,
  high,
  low,
  live,
  ownTempC,
}: {
  sensorKey: SensorKey;
  settings: SensorSettings;
  value: number | null;
  unit: string;
  breach: Breach;
  high: number | null;
  low: number | null;
  live: boolean;
  /** Humidity tiles only: the temperature that sensor measures. */
  ownTempC?: number | null;
}) {
  const missing = value === null;
  const label = settings.labels[sensorKey];
  const limit = breach === "high" ? high : low;
  const limitUnit = unit === "%RH" ? "%" : unit;

  return (
    <article
      className={cx(
        "rounded-xl border px-4 py-3 shadow-[var(--shadow-card)]",
        breach
          ? "border-danger/60 bg-danger-soft"
          : missing
            ? "border-border-base bg-surface-muted"
            : "border-border-base bg-surface",
      )}
    >
      <header className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block size-2.5 shrink-0 rounded-full"
          style={{ background: missing ? "var(--border-strong)" : SENSOR_COLOUR[sensorKey] }}
        />
        <h3 className="min-w-0 truncate text-xs font-semibold text-muted-strong">
          {DEFAULT_SENSOR_LABEL[sensorKey]}
          {label ? <span className="font-normal text-muted"> · {label}</span> : null}
        </h3>
      </header>

      <p className="mt-2 flex items-baseline gap-1">
        <span
          className={cx(
            "tabular text-3xl leading-none font-semibold tracking-tight",
            missing ? "text-muted" : live ? "text-foreground" : "text-muted-strong",
          )}
        >
          {missing ? NO_READING : value.toFixed(1)}
        </span>
        {missing ? null : <span className="text-sm text-muted">{unit}</span>}
      </p>

      <p className="mt-2 min-h-4 text-[11px] leading-4">
        {missing ? (
          <span className="font-medium text-muted">No sensor</span>
        ) : breach && limit !== null ? (
          <span className="font-semibold text-danger">
            {breach === "high" ? "▲ Above" : "▼ Below"} the {limit.toFixed(1)}
            {limitUnit} limit
          </span>
        ) : high !== null || low !== null ? (
          <span className="text-muted">Within limits</span>
        ) : null}
      </p>

      {ownTempC !== undefined ? (
        <p className="tabular mt-1 border-t border-border-base/70 pt-1.5 text-xs text-muted-strong">
          {ownTempC === null ? (
            <span className="text-muted">No temperature from this sensor</span>
          ) : (
            <>
              {formatReading(ownTempC, "°C")}
              <span className="text-muted"> at this sensor</span>
            </>
          )}
        </p>
      ) : null}
    </article>
  );
}

// -------------------------------------------------------------------- history

/** The typical spacing between points, so a real silence can be told from thinning. */
function medianGap(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const gaps = timestamps.slice(1).map((t, index) => t - timestamps[index]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function HistoryCard({
  sensorId,
  settings,
  history,
  range,
  loading,
  error,
  onRangeChange,
}: {
  sensorId: string;
  settings: SensorSettings;
  history: SensorHistoryPayload;
  range: SensorRange;
  loading: boolean;
  error: string | null;
  onRangeChange: (range: SensorRange) => void;
}) {
  const timestamps = useMemo(() => history.points.map((point) => point.t), [history.points]);

  // Three missed frames in a row is an outage; one late frame is not.
  const maxGapMs = useMemo(() => Math.max(medianGap(timestamps) * 3, 45_000), [timestamps]);

  const seriesFor = (keys: readonly SensorKey[]): SensorSeries[] =>
    keys.map((key) => ({
      key,
      label: sensorName(key, settings),
      colour: SENSOR_COLOUR[key],
      values: history.points.map((point) => point[FIELD_OF[key]]),
    }));

  const limits = (high: number | null, low: number | null): ThresholdLine[] => [
    ...(high === null ? [] : [{ key: "high", label: "High", value: high }]),
    ...(low === null ? [] : [{ key: "low", label: "Low", value: low }]),
  ];

  const thinned = history.totalRows > history.points.length;

  return (
    <Card>
      <CardHeader
        title="History"
        description={
          loading
            ? "Loading…"
            : `${history.totalRows.toLocaleString("en-GB")} readings · ${formatDateTime(history.from)} → ${formatDateTime(history.to)}`
        }
        actions={
          <>
            <div className="flex gap-1" role="group" aria-label="Time range">
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
            <a
              href={`/api/sensors/${sensorId}/export.csv?range=${range}`}
              download
              className="rounded-lg border border-border-strong px-2.5 py-1.5 text-xs font-medium hover:border-accent/50"
            >
              Download CSV
            </a>
          </>
        }
      />

      {error ? (
        <p className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-xs text-danger sm:px-5">
          Could not load this range ({error}).
        </p>
      ) : null}

      <div className="space-y-6 px-4 py-4 sm:px-5">
        <div>
          <h3 className="mb-2 text-xs font-semibold text-muted-strong">Temperature (°C)</h3>
          <SensorChart
            title="Temperature"
            timestamps={timestamps}
            series={seriesFor(TEMP_SENSORS)}
            from={history.from}
            to={history.to}
            unit="°C"
            thresholds={limits(settings.tempHighC, settings.tempLowC)}
            maxGapMs={maxGapMs}
          />
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold text-muted-strong">Humidity (%RH)</h3>
          <SensorChart
            title="Humidity"
            timestamps={timestamps}
            series={seriesFor(HUMIDITY_SENSORS)}
            from={history.from}
            to={history.to}
            unit="%"
            thresholds={limits(settings.humidityHighPct, settings.humidityLowPct)}
            maxGapMs={maxGapMs}
          />
        </div>

        <p className="text-[11px] text-muted">
          A break in a line is a sensor that was not reading, or a board that was not reporting.
          {thinned
            ? ` The charts draw ${history.points.length.toLocaleString("en-GB")} of the ${history.totalRows.toLocaleString("en-GB")} readings in this range; the statistics and the CSV use all of them.`
            : ""}
        </p>

        <StatsTable history={history} settings={settings} />
      </div>
    </Card>
  );
}

function StatsTable({
  history,
  settings,
}: {
  history: SensorHistoryPayload;
  settings: SensorSettings;
}) {
  const rows: Array<{ key: string; name: string; colour: string | null; field: SeriesField; unit: string }> = [
    ...SENSOR_KEYS.map((key) => ({
      key,
      name: sensorName(key, settings),
      colour: SENSOR_COLOUR[key],
      field: FIELD_OF[key],
      unit: key.startsWith("t") ? "°C" : "%",
    })),
    ...HUMIDITY_SENSORS.map((key) => ({
      key: `${key}-temp`,
      name: `${sensorName(key, settings)} — temperature`,
      colour: null,
      field: OWN_TEMP_OF[key],
      unit: "°C",
    })),
  ];

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-muted-strong">
        Minimum, maximum and average over this range
      </h3>
      <div className="scroll-x rounded-lg border border-border-base">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead className="bg-surface-muted text-[11px] tracking-wide text-muted uppercase">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Sensor</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Min</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Max</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Average</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Readings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-base">
            {rows.map((row) => {
              const stats = history.stats[row.field];
              return (
                <tr key={row.key}>
                  <th scope="row" className="px-3 py-2 font-medium">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-0.5 w-4 shrink-0 rounded-full"
                        style={{ background: row.colour ?? "transparent" }}
                      />
                      {row.name}
                    </span>
                  </th>
                  <td className="tabular px-3 py-2 text-right">{formatReading(stats.min, row.unit)}</td>
                  <td className="tabular px-3 py-2 text-right">{formatReading(stats.max, row.unit)}</td>
                  <td className="tabular px-3 py-2 text-right">{formatReading(stats.avg, row.unit)}</td>
                  <td className="tabular px-3 py-2 text-right text-muted">
                    {stats.count === 0 ? "No sensor" : stats.count.toLocaleString("en-GB")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- settings

/** Empty means "no limit"; anything else has to be a number. */
function parseLimit(text: string): number | null | "invalid" {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : "invalid";
}

const limitText = (value: number | null) => (value === null ? "" : String(value));

function SettingsCard({
  sensorId,
  settings,
  saved,
  onSaved,
}: {
  sensorId: string;
  settings: SensorSettings;
  saved: boolean;
  onSaved: () => void;
}) {
  const [limits, setLimits] = useState({
    tempHighC: limitText(settings.tempHighC),
    tempLowC: limitText(settings.tempLowC),
    humidityHighPct: limitText(settings.humidityHighPct),
    humidityLowPct: limitText(settings.humidityLowPct),
  });
  const [labels, setLabels] = useState<Record<SensorKey, string>>(
    () =>
      Object.fromEntries(SENSOR_KEYS.map((key) => [key, settings.labels[key] ?? ""])) as Record<
        SensorKey,
        string
      >,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();

    const parsed = {
      tempHighC: parseLimit(limits.tempHighC),
      tempLowC: parseLimit(limits.tempLowC),
      humidityHighPct: parseLimit(limits.humidityHighPct),
      humidityLowPct: parseLimit(limits.humidityLowPct),
    };
    if (Object.values(parsed).includes("invalid")) {
      setError("Limits must be numbers. Leave a limit empty to switch it off.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sensors/${sensorId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed, labels }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const limitInput = (
    key: keyof typeof limits,
    label: string,
    unit: string,
  ) => (
    <label className="block text-xs">
      <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        <input
          type="text"
          inputMode="decimal"
          value={limits[key]}
          onChange={(event) => setLimits((previous) => ({ ...previous, [key]: event.target.value }))}
          placeholder="No limit"
          autoComplete="off"
          className="tabular block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-sm placeholder:text-muted"
        />
        <span className="w-6 shrink-0 text-muted">{unit}</span>
      </span>
    </label>
  );

  return (
    <Card>
      <CardHeader
        title="Alert limits and sensor names"
        description="Saved for this board. A reading outside its limits turns the tile red and is logged."
      />
      <form onSubmit={save} className="space-y-4 px-4 py-4 sm:px-5">
        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-muted-strong">
            Temperature — applies to T1 to T4
          </legend>
          <div className="grid grid-cols-2 gap-3">
            {limitInput("tempHighC", "High", "°C")}
            {limitInput("tempLowC", "Low", "°C")}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-muted-strong">
            Humidity — applies to H1 and H2
          </legend>
          <div className="grid grid-cols-2 gap-3">
            {limitInput("humidityHighPct", "High", "%")}
            {limitInput("humidityLowPct", "Low", "%")}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-muted-strong">Sensor names</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {SENSOR_KEYS.map((key) => (
              <label key={key} className="block text-xs">
                <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
                  <span
                    aria-hidden
                    className="inline-block size-2 rounded-full"
                    style={{ background: SENSOR_COLOUR[key] }}
                  />
                  {DEFAULT_SENSOR_LABEL[key]}
                </span>
                <input
                  type="text"
                  value={labels[key]}
                  onChange={(event) =>
                    setLabels((previous) => ({ ...previous, [key]: event.target.value }))
                  }
                  maxLength={SENSOR_LABEL_MAX_LENGTH}
                  placeholder={key.startsWith("t") ? "e.g. Cold room" : "e.g. Store"}
                  autoComplete="off"
                  className="mt-1 block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-sm placeholder:text-muted"
                />
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center justify-end gap-3">
          {error ? <p className="mr-auto text-xs text-danger">{error}</p> : null}
          {saved && !error ? (
            <p className="mr-auto text-xs font-medium text-ok" role="status">
              ✓ Saved
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Card>
  );
}

// --------------------------------------------------------------------- alerts

function AlertsCard({ alerts, settings }: { alerts: SensorAlert[]; settings: SensorSettings }) {
  const open = alerts.filter((alert) => alert.clearedAt === null).length;

  return (
    <Card>
      <CardHeader
        title="Alerts"
        description={
          alerts.length === 0
            ? "Nothing logged"
            : `${open} active · ${alerts.length - open} cleared · newest first`
        }
      />
      {alerts.length === 0 ? (
        <EmptyState
          title="No alerts"
          description="A reading outside the limits set for this board is logged here with the time it started."
        />
      ) : (
        <ul className="max-h-[420px] divide-y divide-border-base overflow-y-auto">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
              <Badge tone={alert.clearedAt === null ? "danger" : "neutral"} className="mt-0.5">
                {alert.clearedAt === null ? "Active" : "Cleared"}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">{alert.message}</p>
                <p className="tabular mt-0.5 text-[11px] text-muted">
                  {sensorName(alert.sensor, settings)} · started {formatDateTime(alert.raisedAt)}
                  {alert.clearedAt === null ? "" : ` · cleared ${formatDateTime(alert.clearedAt)}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ simulator

const SIMULATION_INTERVAL_MS = 5_000;
const TEMP_RANGE = { min: 20, max: 35 };
const HUMIDITY_RANGE = { min: 40, max: 80 };

interface SimValues {
  temps: [number, number, number, number];
  humidity: [number, number];
  ownTemps: [number, number];
  rssi: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, range: { min: number; max: number }) =>
  Math.min(range.max, Math.max(range.min, value));
const anywhere = (range: { min: number; max: number }) =>
  round1(range.min + Math.random() * (range.max - range.min));
const drift = (value: number, step: number, range: { min: number; max: number }) =>
  round1(clamp(value + (Math.random() - 0.5) * 2 * step, range));

/** Fresh random values, or the previous ones nudged so a run reads like a room. */
function nextValues(previous: SimValues | null): SimValues {
  if (previous === null) {
    return {
      temps: [anywhere(TEMP_RANGE), anywhere(TEMP_RANGE), anywhere(TEMP_RANGE), anywhere(TEMP_RANGE)],
      humidity: [anywhere(HUMIDITY_RANGE), anywhere(HUMIDITY_RANGE)],
      ownTemps: [anywhere(TEMP_RANGE), anywhere(TEMP_RANGE)],
      rssi: -50 - Math.round(Math.random() * 25),
    };
  }
  return {
    temps: previous.temps.map((value) => drift(value, 0.4, TEMP_RANGE)) as SimValues["temps"],
    humidity: previous.humidity.map((value) => drift(value, 1, HUMIDITY_RANGE)) as SimValues["humidity"],
    ownTemps: previous.ownTemps.map((value) => drift(value, 0.3, TEMP_RANGE)) as SimValues["ownTemps"],
    rssi: Math.round(clamp(previous.rssi + (Math.random() - 0.5) * 4, { min: -85, max: -45 })),
  };
}

/** The frame the firmware sends, field for field. */
function buildFrame(values: SimValues, missing: boolean, uptimeSeconds: number) {
  const temp4C = missing ? null : values.temps[3];
  const humidity2Pct = missing ? null : values.humidity[1];
  const probes = [values.temps[0], values.temps[1], values.temps[2], temp4C];
  const reading = [...probes, values.humidity[0], humidity2Pct].filter((value) => value !== null);

  return {
    level: "off",
    levelValue: 0,
    manual: false,
    autoFan: false,
    tripped: false,
    climate: false,
    totalCurrentA: 0,
    sumCurrentA: 0,
    totalPowerW: 0,
    readingSource: "ct",
    temp1C: values.temps[0],
    temp2C: values.temps[1],
    temp3C: values.temps[2],
    temp4C,
    maxTempC: Math.max(...probes.filter((value): value is number => value !== null)),
    humidity1Pct: values.humidity[0],
    humidity2Pct,
    dhtTempC: values.ownTemps[0],
    // The second humidity sensor is the one that measures this, so it goes too.
    dht2TempC: missing ? null : values.ownTemps[1],
    sensorsOk: reading.length,
    deviceType: "temphum",
    wifi: "STA",
    ip: "192.168.1.50",
    bluetoothClient: false,
    apiKeySet: false,
    uptimeSeconds,
    rssi: values.rssi,
    channels: [],
  };
}

interface SimLogEntry {
  id: number;
  at: number;
  ok: boolean;
  status: number | null;
  summary: string;
}

function SimulatorCard({
  sensorId,
  online,
  onSent,
}: {
  sensorId: string;
  online: boolean;
  onSent: () => void;
}) {
  const [missing, setMissing] = useState(false);
  const [running, setRunning] = useState(false);
  const [sending, setSending] = useState(false);
  const [log, setLog] = useState<SimLogEntry[]>([]);

  const missingRef = useRef(missing);
  const previous = useRef<SimValues | null>(null);
  const startedAt = useRef<number | null>(null);
  const entryId = useRef(0);

  const send = useCallback(
    async (mode: "single" | "run") => {
      // One press is a fresh set of random values; a run drifts from the last.
      const values = nextValues(mode === "run" ? previous.current : null);
      previous.current = values;
      startedAt.current ??= Date.now();

      const frame = buildFrame(
        values,
        missingRef.current,
        Math.round((Date.now() - startedAt.current) / 1000),
      );
      const summary =
        `T ${[frame.temp1C, frame.temp2C, frame.temp3C, frame.temp4C].map((v) => formatReading(v, "")).join(" / ")}` +
        ` · H ${[frame.humidity1Pct, frame.humidity2Pct].map((v) => formatReading(v, "")).join(" / ")}`;

      const record = (entry: Omit<SimLogEntry, "id" | "at">) =>
        setLog((entries) =>
          [{ id: (entryId.current += 1), at: Date.now(), ...entry }, ...entries].slice(0, 8),
        );

      setSending(true);
      try {
        // The same endpoint the board posts to. The browser holds no device
        // key, so the request is authorised by the admin sign-in instead.
        const response = await fetch(`/api/devices/${sensorId}/telemetry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(frame),
        });
        if (response.ok) {
          record({ ok: true, status: response.status, summary });
          onSent();
        } else {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          record({
            ok: false,
            status: response.status,
            summary: body?.error ?? "The server refused the frame",
          });
        }
      } catch (cause) {
        record({
          ok: false,
          status: null,
          summary: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setSending(false);
      }
    },
    [sensorId, onSent],
  );

  useEffect(() => {
    if (!running) return;
    const first = setTimeout(() => void send("run"), 0);
    const timer = setInterval(() => void send("run"), SIMULATION_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [running, send]);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Test / Simulator <Badge tone="warn">Admin only</Badge>
          </span>
        }
        description="Posts frames to the real telemetry endpoint, so they are stored, charted and checked against the limits exactly like a reading from the board."
      />
      <div className="space-y-4 px-4 py-4 sm:px-5">
        {online && !running ? (
          <p className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
            This board is reporting. Test frames will be mixed into its real readings and its
            history.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void send("single")}
            disabled={sending || running}
            className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            Send test reading
          </button>

          <button
            type="button"
            onClick={() => setRunning((value) => !value)}
            aria-pressed={running}
            className={cx(
              "rounded-lg border px-3 py-2 text-xs font-semibold",
              running
                ? "border-danger/60 bg-danger-soft text-danger"
                : "border-border-strong hover:border-accent/50",
            )}
          >
            {running ? "Stop simulation" : "Start simulation"}
          </button>

          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={missing}
              onChange={(event) => {
                setMissing(event.target.checked);
                missingRef.current = event.target.checked;
              }}
              className="size-4 accent-[var(--accent)]"
            />
            <span>
              Simulate sensor missing
              <span className="text-muted"> — sends T4 and H2 as null</span>
            </span>
          </label>
        </div>

        <p className="text-[11px] text-muted" role="status">
          {running
            ? `Simulation running: one frame every ${SIMULATION_INTERVAL_MS / 1000} s until stopped or this page is closed.`
            : `Temperatures ${TEMP_RANGE.min}–${TEMP_RANGE.max} °C, humidity ${HUMIDITY_RANGE.min}–${HUMIDITY_RANGE.max} %. Stop sending for 60 s and the board shows as offline.`}
        </p>

        {log.length > 0 ? (
          <ul className="divide-y divide-border-base rounded-lg border border-border-base text-xs">
            {log.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-3 py-2">
                <span className="tabular shrink-0 text-muted">{formatClock(entry.at)}</span>
                <Badge tone={entry.ok ? "ok" : "danger"}>
                  {entry.status === null ? "No response" : `HTTP ${entry.status}`}
                </Badge>
                <span className="tabular min-w-0 truncate" title={entry.summary}>
                  {entry.summary}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
