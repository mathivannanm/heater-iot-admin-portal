import type { NextRequest } from "next/server";
import { authFailure, fail, ok, resolveRange } from "@/lib/api";
import { authenticateAdmin } from "@/lib/auth";
import {
  getChannelSeries,
  getDeviceView,
  getEnergyBuckets,
  getOutages,
  getTelemetrySeries,
  listAlerts,
} from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/devices/:id/history?range=today|24h|7d|30d|custom&from=&to=
 *
 * Everything the detail page charts for one window: the telemetry series, the
 * per-channel series, the hourly energy rollup, the alerts raised inside it and
 * the outages (gaps in reporting) so downtime can be drawn and totalled.
 * One request rather than four, so the charts cannot render against windows
 * that drifted apart while separate requests were in flight.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/history">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const device = await getDeviceView(id);
  if (!device) return fail(404, "Device not found");

  const generatedAt = Date.now();
  const { from, to, range } = resolveRange(request.nextUrl.searchParams, generatedAt);

  const [telemetry, channels, energy, alerts, outages] = await Promise.all([
    getTelemetrySeries(id, from, to),
    getChannelSeries(id, from, to),
    getEnergyBuckets(id, from, to),
    listAlerts({ deviceId: id, from, to, limit: 200 }),
    getOutages(id, from, to, generatedAt),
  ]);

  return ok({ range, from, to, generatedAt, telemetry, channels, energy, alerts, outages });
}

export const GET = withApiLog("/api/devices/[id]/history", handleGET);
