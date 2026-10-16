import { notFound } from "next/navigation";
import { SensorDetail } from "@/components/sensor-detail";
import { nowMs } from "@/lib/clock";
import { config } from "@/lib/config";
import { getSensor, getSensorHistory, listSensorAlerts, resolveSensorRange } from "@/lib/sensors";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/sensors/[id]">) {
  const { id } = await params;
  const sensor = await getSensor(id);
  return { title: sensor ? `${sensor.name} · Temperature & Humidity` : "Sensor not found" };
}

/**
 * Server-renders the sensor with its last 24 hours of history, so the page is
 * populated before any JavaScript runs. The client component then polls for
 * the newest reading and re-reads the history when the range changes.
 */
export default async function SensorDetailPage({ params }: PageProps<"/sensors/[id]">) {
  const { id } = await params;
  const now = nowMs();

  const sensor = await getSensor(id, now);
  if (!sensor) notFound();

  const { from, to } = resolveSensorRange("24h", now);
  const [history, alerts] = await Promise.all([
    getSensorHistory(id, from, to),
    listSensorAlerts(id, { limit: 50 }),
  ]);

  return (
    <SensorDetail
      initial={{
        sensor,
        alerts,
        serverTime: now,
        offlineTimeoutMs: config.sensor.offlineTimeoutMs,
      }}
      initialHistory={{ range: "24h", ...history }}
    />
  );
}
