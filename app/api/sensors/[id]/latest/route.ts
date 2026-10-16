import type { NextRequest } from "next/server";
import { authFailure, fail, ok } from "@/lib/api";
import { withApiLog } from "@/lib/api-log";
import { authenticateAdmin } from "@/lib/auth";
import { config } from "@/lib/config";
import { getSensor, listSensorAlerts } from "@/lib/sensors";

/**
 * GET /api/sensors/:id/latest - the newest reading from one sensor board.
 *
 * This is what the detail page polls. The device, its settings and its alerts
 * come back together so the tiles, the thresholds that colour them and the
 * alert list are always from the same instant.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/sensors/[id]/latest">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const now = Date.now();

  const sensor = await getSensor(id, now);
  if (!sensor) return fail(404, "Sensor not found");

  return ok({
    sensor,
    latest: sensor.latest,
    alerts: await listSensorAlerts(id, { limit: 50 }),
    serverTime: now,
    offlineTimeoutMs: config.sensor.offlineTimeoutMs,
  });
}

export const GET = withApiLog("/api/sensors/[id]/latest", handleGET);
