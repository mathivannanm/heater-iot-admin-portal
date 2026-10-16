import { SensorList } from "@/components/sensor-list";
import { nowMs } from "@/lib/clock";
import { config } from "@/lib/config";
import { listSensors } from "@/lib/sensors";

export const metadata = {
  title: "Temperature & Humidity · HEATER Ver1",
};

export const dynamic = "force-dynamic";

/**
 * The sensor index: every TEMP-HUM Ver1 board, read straight from Postgres for
 * the first paint. The client component then polls the same data over the API.
 */
export default async function SensorsPage() {
  const now = nowMs();
  const sensors = await listSensors(now);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Temperature &amp; Humidity</h1>
        <p className="mt-0.5 text-sm text-muted">
          Sensor boards with four temperature probes and two humidity sensors. Refreshes every 5
          seconds; a board is offline after {Math.round(config.sensor.offlineTimeoutMs / 1000)}{" "}
          seconds of silence.
        </p>
      </header>

      <SensorList
        initial={{ sensors, serverTime: now, offlineTimeoutMs: config.sensor.offlineTimeoutMs }}
      />
    </div>
  );
}
