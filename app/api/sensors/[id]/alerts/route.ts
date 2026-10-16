import type { NextRequest } from "next/server";
import { authFailure, fail, ok } from "@/lib/api";
import { withApiLog } from "@/lib/api-log";
import { authenticateAdmin } from "@/lib/auth";
import { getSensor, listSensorAlerts } from "@/lib/sensors";

/**
 * GET /api/sensors/:id/alerts?open=true|false&limit=
 *
 * Threshold alerts for one sensor board, open ones first. An alert clears when
 * a frame arrives with the reading back inside its limits; there is nothing to
 * acknowledge and no way to clear one by hand.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/sensors/[id]/alerts">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  if (!(await getSensor(id))) return fail(404, "Sensor not found");

  const params = request.nextUrl.searchParams;
  const openParam = params.get("open");
  const limit = Number(params.get("limit") ?? 100);

  return ok({
    alerts: await listSensorAlerts(id, {
      open: openParam === null ? undefined : openParam !== "false",
      limit: Number.isFinite(limit) ? limit : 100,
    }),
  });
}

export const GET = withApiLog("/api/sensors/[id]/alerts", handleGET);
