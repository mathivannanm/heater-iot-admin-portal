import { notFound, redirect } from "next/navigation";
import { DeviceDetail, type HistoryPayload } from "@/components/device-detail";
import { resolveRange } from "@/lib/api";
import { nowMs } from "@/lib/clock";
import {
  getChannelSeries,
  getDeviceView,
  getEnergyBuckets,
  getOutages,
  getTelemetrySeries,
  listAlerts,
  listAudit,
  listCommands,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/devices/[id]">) {
  const { id } = await params;
  const device = await getDeviceView(id);
  return { title: device ? `${device.name} · HEATER Ver1` : "Device not found" };
}

/**
 * Server-renders the device with today's history, so the page is
 * populated before any JavaScript runs. The client component then takes over:
 * live state from the SSE mirror, and a fresh history fetch when the range
 * selector changes.
 */
export default async function DeviceDetailPage({ params }: PageProps<"/devices/[id]">) {
  const { id } = await params;

  const device = await getDeviceView(id);
  if (!device) notFound();
  // A sensor board has no relays to show here; it has its own page.
  if (device.deviceType === "temphum") redirect(`/sensors/${id}`);

  const generatedAt = nowMs();
  const { from, to, range } = resolveRange(new URLSearchParams({ range: "today" }), generatedAt);

  const [telemetry, channels, energy, alerts, commands, audit, outages] = await Promise.all([
    getTelemetrySeries(id, from, to),
    getChannelSeries(id, from, to),
    getEnergyBuckets(id, from, to),
    listAlerts({ deviceId: id, limit: 50 }),
    listCommands(id, 25),
    listAudit({ deviceId: id, limit: 25 }),
    getOutages(id, from, to, generatedAt),
  ]);

  const history: HistoryPayload = {
    range,
    from,
    to,
    generatedAt,
    outages,
    telemetry,
    channels,
    energy,
    alerts,
  };

  return (
    <DeviceDetail
      device={device}
      alerts={alerts}
      commands={commands}
      audit={audit}
      history={history}
    />
  );
}
