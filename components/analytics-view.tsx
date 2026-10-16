"use client";

import Link from "next/link";
import { useMemo } from "react";
import { TimeSeriesChart, type Series } from "./charts";
import { SeverityBadge } from "./status";
import { Card, CardHeader, EmptyState, cx } from "./ui/primitives";
import { CHANNEL_KIND_LABEL, formatEnergy, formatPower, formatTemp } from "@/lib/format";
import type { AlertSeverity, ChannelKind } from "@/lib/types";

/**
 * Historical analytics across the whole fleet.
 *
 * Every figure here is read back out of Postgres - the hourly `energy_hourly`
 * rollup and the raw `telemetry` table - rather than accumulated in memory, so
 * the numbers survive a restart and mean the same thing tomorrow.
 */

export interface AnalyticsData {
  from: number;
  to: number;
  rangeLabel: string;
  energy: Array<{ bucket: number; energyWh: number; avgPowerW: number; peakPowerW: number }>;
  byDevice: Array<{ deviceId: string; deviceName: string; energyWh: number; peakPowerW: number }>;
  byKind: Array<{ kind: string; energyWh: number }>;
  alertCounts: Array<{ code: string; severity: AlertSeverity; count: number; devices: number }>;
  temperature: Array<{ bucket: number; avgC: number | null; maxC: number | null; minC: number | null }>;
}

export function AnalyticsView({ data }: { data: AnalyticsData }) {
  const energyTimestamps = useMemo(() => data.energy.map((point) => point.bucket), [data.energy]);

  const powerSeries: Series[] = useMemo(
    () => [
      {
        key: "avg",
        label: "Average power",
        colour: "#e05a10",
        values: data.energy.map((point) => point.avgPowerW),
        unit: "W",
        decimals: 0,
      },
      {
        key: "peak",
        label: "Peak power",
        colour: "#d32f2f",
        values: data.energy.map((point) => point.peakPowerW),
        dashed: true,
        unit: "W",
        decimals: 0,
      },
    ],
    [data.energy],
  );

  const tempTimestamps = useMemo(
    () => data.temperature.map((point) => point.bucket),
    [data.temperature],
  );

  const tempSeries: Series[] = useMemo(
    () => [
      {
        key: "max",
        label: "Hottest",
        colour: "#d32f2f",
        values: data.temperature.map((point) => point.maxC),
        unit: "°C",
        decimals: 1,
      },
      {
        key: "avg",
        label: "Average",
        colour: "#e05a10",
        values: data.temperature.map((point) => point.avgC),
        unit: "°C",
        decimals: 1,
      },
      {
        key: "min",
        label: "Coolest",
        colour: "#0e7490",
        values: data.temperature.map((point) => point.minC),
        unit: "°C",
        decimals: 1,
      },
    ],
    [data.temperature],
  );

  const totalEnergy = data.energy.reduce((sum, point) => sum + point.energyWh, 0);
  const peakPower = data.energy.reduce((peak, point) => Math.max(peak, point.peakPowerW), 0);
  const peakDeviceEnergy = Math.max(1, ...data.byDevice.map((entry) => entry.energyWh));
  const kindTotal = Math.max(1, data.byKind.reduce((sum, entry) => sum + entry.energyWh, 0));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat label="Energy used" value={formatEnergy(totalEnergy)} hint={data.rangeLabel} />
        <Stat label="Peak draw" value={formatPower(peakPower)} hint="highest hourly peak" />
        <Stat
          label="Hottest recorded"
          value={formatTemp(
            data.temperature.reduce<number | null>(
              (peak, point) => (point.maxC === null ? peak : peak === null ? point.maxC : Math.max(peak, point.maxC)),
              null,
            ),
          )}
          hint="across every probe"
        />
        <Stat
          label="Alerts raised"
          value={String(data.alertCounts.reduce((sum, entry) => sum + entry.count, 0))}
          hint={`${data.alertCounts.length} distinct codes`}
        />
      </div>

      <Card>
        <CardHeader title="Fleet power" description={`Hourly average and peak · ${data.rangeLabel}`} />
        <div className="px-4 py-4 sm:px-5">
          <TimeSeriesChart
            timestamps={energyTimestamps}
            series={powerSeries}
            height={220}
            yLabel="W"
            yMin={0}
            emptyMessage="No energy recorded in this range"
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Temperature envelope"
          description="Hottest, average and coolest probe reading per hour across the fleet"
        />
        <div className="px-4 py-4 sm:px-5">
          <TimeSeriesChart
            timestamps={tempTimestamps}
            series={tempSeries}
            height={220}
            yLabel="°C"
            emptyMessage="No temperature readings in this range"
          />
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Energy by device" description="Which units are using the power" />
          {data.byDevice.length === 0 ? (
            <EmptyState title="No energy recorded in this range" />
          ) : (
            <ul className="divide-y divide-border-base">
              {data.byDevice.slice(0, 10).map((entry) => (
                <li key={entry.deviceId} className="px-4 py-2.5 sm:px-5">
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <Link
                      href={`/devices/${entry.deviceId}`}
                      className="truncate font-medium hover:text-accent"
                    >
                      {entry.deviceName}
                    </Link>
                    <span className="tabular shrink-0 text-muted">
                      {formatEnergy(entry.energyWh)} · peak {formatPower(entry.peakPowerW)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className="h-full rounded-full bg-heat"
                      style={{ width: `${(entry.energyWh / peakDeviceEnergy) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Where the energy goes"
            description="Split by channel type across the fleet"
          />
          {data.byKind.length === 0 ? (
            <EmptyState title="No energy recorded in this range" />
          ) : (
            <div className="space-y-3 px-4 py-3.5 sm:px-5">
              {data.byKind.map((entry) => {
                const share = (entry.energyWh / kindTotal) * 100;
                return (
                  <div key={entry.kind}>
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="font-medium">
                        {CHANNEL_KIND_LABEL[entry.kind as ChannelKind] ?? entry.kind}
                      </span>
                      <span className="tabular text-muted">
                        {formatEnergy(entry.energyWh)} · {Math.round(share)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className={cx(
                          "h-full rounded-full",
                          entry.kind === "heater" ? "bg-heat" : entry.kind === "fan" ? "bg-wifi" : "bg-warn",
                        )}
                        style={{ width: `${share}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Alert frequency"
          description="Which faults actually happen, and on how many devices"
        />
        {data.alertCounts.length === 0 ? (
          <EmptyState
            title="No alerts raised in this range"
            description="Nothing exceeded a protection limit and no channel reported a fault."
          />
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-border-base text-left">
                  {["Severity", "Code", "Occurrences", "Devices affected"].map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="px-4 py-2 text-[11px] font-medium tracking-wide text-muted uppercase"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.alertCounts.map((entry) => (
                  <tr key={`${entry.code}-${entry.severity}`} className="border-b border-border-base last:border-0">
                    <td className="px-4 py-2.5">
                      <SeverityBadge severity={entry.severity} />
                    </td>
                    <td className="font-mono px-4 py-2.5 text-xs">{entry.code}</td>
                    <td className="tabular px-4 py-2.5">{entry.count}</td>
                    <td className="tabular px-4 py-2.5 text-muted">{entry.devices}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border-base bg-surface px-3 py-3 shadow-[var(--shadow-card)]">
      <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold leading-none">{value}</p>
      {hint ? <p className="mt-1.5 truncate text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}
