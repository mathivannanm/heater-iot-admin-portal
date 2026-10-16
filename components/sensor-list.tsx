"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import {
  NO_READING,
  OnlineBadge,
  POLL_INTERVAL_MS,
  formatReading,
  liveSignal,
  liveStatus,
  sensorName,
  usePolling,
  useServerNow,
  type ClockSync,
} from "./sensor-shared";
import { SignalMeter } from "./status";
import { Badge, Card, EmptyState, cx } from "./ui/primitives";
import { formatAge } from "@/lib/format";
import type { SensorDevice } from "@/lib/sensor-types";

/**
 * The sensor index: one card per temperature / humidity board.
 *
 * Polls the list every few seconds rather than riding the SSE stream, which
 * carries the heater fleet and nothing else.
 */

export interface SensorListPayload {
  sensors: SensorDevice[];
  serverTime: number;
  offlineTimeoutMs: number;
}

export function SensorList({ initial }: { initial: SensorListPayload }) {
  const [data, setData] = useState(initial);
  const [sync, setSync] = useState<ClockSync | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/sensors", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as SensorListPayload;
      setData(body);
      setSync({ serverTime: body.serverTime, receivedAt: Date.now() });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  usePolling(refresh, POLL_INTERVAL_MS);
  const serverNow = useServerNow(sync);

  const statuses = data.sensors.map((sensor) => liveStatus(sensor, serverNow, data.offlineTimeoutMs));
  const onlineCount = statuses.filter((status) => status.online).length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {data.sensors.length === 0
          ? "No sensor boards registered"
          : `${data.sensors.length} sensor board${data.sensors.length === 1 ? "" : "s"} · ${onlineCount} online`}
        {error ? (
          <span className="ml-2 text-warn">
            Could not refresh ({error}) — showing the last data received
          </span>
        ) : null}
      </p>

      {data.sensors.length === 0 ? (
        <Card>
          <EmptyState
            title="No temperature / humidity sensors yet"
            description="A board appears here once it registers with the model “TEMP-HUM Ver1”. To try the page without hardware, run: node scripts/simulate-temphum.mjs <server-url> <admin-key>"
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.sensors.map((sensor, index) => (
            <SensorCard key={sensor.id} sensor={sensor} status={statuses[index]} />
          ))}
        </div>
      )}
    </div>
  );
}

function SensorCard({
  sensor,
  status,
}: {
  sensor: SensorDevice;
  status: ReturnType<typeof liveStatus>;
}) {
  const latest = sensor.latest;

  return (
    <Link
      href={`/sensors/${sensor.id}`}
      className="group block rounded-xl focus-visible:outline-offset-4"
      aria-label={`${sensor.name}, ${status.online ? "online" : "offline"}. Open details.`}
    >
      <Card
        as="article"
        className="h-full transition-colors group-hover:border-accent/50"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-base px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight group-hover:text-accent">
              {sensor.name}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
              {sensor.serialNumber ?? "No serial"}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <OnlineBadge status={status} />
            <span className="tabular text-[11px] text-muted">
              {status.ageMs === null ? "never reported" : `seen ${formatAge(status.ageMs)}`}
            </span>
          </div>
        </header>

        <dl className="grid grid-cols-3 gap-x-3 gap-y-3 px-4 py-3">
          <Reading
            label="Max temp"
            value={formatReading(latest?.maxTempC, "°C")}
            dim={!status.online}
          />
          <Reading
            label={sensorName("h1", sensor.settings)}
            value={formatReading(latest?.humidity1Pct, "%")}
            dim={!status.online}
          />
          <Reading
            label={sensorName("h2", sensor.settings)}
            value={formatReading(latest?.humidity2Pct, "%")}
            dim={!status.online}
          />
        </dl>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border-base px-4 py-2.5">
          <SignalMeter device={{ signal: liveSignal(sensor, status.online) }} showValue />
          <span className="flex items-center gap-2">
            {sensor.openAlertCount > 0 ? (
              <Badge tone="danger">
                {sensor.openAlertCount} alert{sensor.openAlertCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
            <SensorsOk ok={latest?.sensorsOk ?? null} total={latest?.sensorsTotal ?? null} />
          </span>
        </footer>
      </Card>
    </Link>
  );
}

function Reading({ label, value, dim }: { label: string; value: string; dim: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-medium tracking-wide text-muted uppercase" title={label}>
        {label}
      </dt>
      <dd
        className={cx(
          "tabular mt-0.5 text-base font-semibold",
          value === NO_READING ? "text-muted" : dim ? "text-muted-strong" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** "5/6": how many of the board's sensors are reading. */
export function SensorsOk({ ok, total }: { ok: number | null; total: number | null }) {
  if (ok === null || total === null) {
    return <span className="text-xs text-muted">Sensors {NO_READING}</span>;
  }
  return (
    <Badge
      tone={ok >= total ? "ok" : "warn"}
      title={ok >= total ? "Every sensor is reading" : `${total - ok} sensor(s) not reading`}
    >
      Sensors {ok}/{total}
    </Badge>
  );
}
