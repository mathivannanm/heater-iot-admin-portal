import type { NextRequest } from "next/server";
import { authFailure, fail, ok } from "@/lib/api";
import { withApiLog } from "@/lib/api-log";
import { authenticateAdmin } from "@/lib/auth";
import {
  SENSOR_RANGES,
  getSensor,
  getSensorHistory,
  isSensorRange,
  resolveSensorRange,
} from "@/lib/sensors";

/**
 * GET /api/sensors/:id/history?range=1h|6h|24h|7d
 *
 * The time series of all eight values for the charts, thinned to a few
 * thousand real readings, plus min / max / average per sensor computed over
 * every frame stored in the window.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/sensors/[id]/history">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const range = request.nextUrl.searchParams.get("range") ?? "24h";
  if (!isSensorRange(range)) {
    return fail(422, `"range" must be one of: ${SENSOR_RANGES.join(", ")}`);
  }

  if (!(await getSensor(id))) return fail(404, "Sensor not found");

  const { from, to } = resolveSensorRange(range);
  return ok({ range, ...(await getSensorHistory(id, from, to)) });
}

export const GET = withApiLog("/api/sensors/[id]/history", handleGET);
