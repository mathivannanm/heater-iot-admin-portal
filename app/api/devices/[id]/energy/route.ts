import type { NextRequest } from "next/server";
import { authFailure, fail, ok, resolveRange } from "@/lib/api";
import { authenticateAdmin } from "@/lib/auth";
import { getDeviceView, getEnergyBuckets } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/devices/:id/energy?range=...
 *
 * The hourly per-channel energy rollup from `energy_hourly`, plus a per-channel
 * total for the window. Reads the rollup rather than re-integrating raw
 * telemetry, so a month-long query stays a few hundred rows.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/energy">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const device = await getDeviceView(id);
  if (!device) return fail(404, "Device not found");

  const { from, to, range } = resolveRange(request.nextUrl.searchParams);
  const buckets = await getEnergyBuckets(id, from, to);

  const totals = new Map<
    number,
    { channelIndex: number; channelId: string; name: string; energyWh: number; peakPowerW: number; onSamples: number }
  >();

  for (const bucket of buckets) {
    const existing = totals.get(bucket.channelIndex);
    if (existing) {
      existing.energyWh += bucket.energyWh;
      existing.peakPowerW = Math.max(existing.peakPowerW, bucket.peakPowerW);
      existing.onSamples += bucket.onSamples;
    } else {
      totals.set(bucket.channelIndex, {
        channelIndex: bucket.channelIndex,
        channelId: bucket.channelId,
        name:
          device.channels.find((channel) => channel.channelIndex === bucket.channelIndex)?.name ??
          bucket.channelId,
        energyWh: bucket.energyWh,
        peakPowerW: bucket.peakPowerW,
        onSamples: bucket.onSamples,
      });
    }
  }

  return ok({
    range,
    from,
    to,
    buckets,
    totals: [...totals.values()].sort((a, b) => a.channelIndex - b.channelIndex),
  });
}

export const GET = withApiLog("/api/devices/[id]/energy", handleGET);
