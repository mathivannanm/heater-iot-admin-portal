import type { NextRequest } from "next/server";
import { authFailure, fail } from "@/lib/api";
import { withApiLog } from "@/lib/api-log";
import { authenticateAdmin } from "@/lib/auth";
import {
  SENSOR_RANGES,
  exportSensorCsv,
  getSensor,
  isSensorRange,
  resolveSensorRange,
} from "@/lib/sensors";

/**
 * GET /api/sensors/:id/export.csv?range=1h|6h|24h|7d
 *
 * Every frame stored in the window, as a CSV download. Unlike the history
 * endpoint nothing is thinned: the file is the record, the chart is a view.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/sensors/[id]/export.csv">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const range = request.nextUrl.searchParams.get("range") ?? "24h";
  if (!isSensorRange(range)) {
    return fail(422, `"range" must be one of: ${SENSOR_RANGES.join(", ")}`);
  }

  const sensor = await getSensor(id);
  if (!sensor) return fail(404, "Sensor not found");

  const { from, to } = resolveSensorRange(range);
  const { csv, rows, truncated } = await exportSensorCsv(id, from, to);

  // Only characters that are safe unquoted in a header and on every filesystem.
  const slug = (sensor.serialNumber ?? sensor.name).replace(/[^A-Za-z0-9_-]+/g, "-");
  const stamp = new Date(to).toISOString().slice(0, 19).replace(/[-:]/g, "");
  const filename = `temphum-${slug || "sensor"}-${range}-${stamp}Z.csv`;

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-row-count": String(rows),
      "x-truncated": String(truncated),
    },
  });
}

export const GET = withApiLog("/api/sensors/[id]/export.csv", handleGET);
