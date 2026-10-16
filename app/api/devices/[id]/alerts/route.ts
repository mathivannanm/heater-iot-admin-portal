import type { NextRequest } from "next/server";
import { authFailure, fail, ok, optionalString, readJson } from "@/lib/api";
import { authenticateAdmin, clientIp } from "@/lib/auth";
import { acknowledgeAlert, getDeviceView, listAlerts, recordAudit } from "@/lib/store";
import type { AlertSeverity } from "@/lib/types";
import { withApiLog } from "@/lib/api-log";

/**
 * GET   /api/devices/:id/alerts - fault log for one device.
 * PATCH /api/devices/:id/alerts - acknowledge an alert.
 *
 * Acknowledging records that a human has seen the alert. It deliberately does
 * not clear it: an alert clears when the condition that raised it stops being
 * true in an ingested frame, never because somebody clicked a button.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/alerts">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const params = request.nextUrl.searchParams;
  const openParam = params.get("open");

  return ok({
    alerts: await listAlerts({
      deviceId: id,
      open: openParam === null ? undefined : openParam !== "false",
      severity: (params.get("severity") as AlertSeverity | null) ?? undefined,
      limit: Number(params.get("limit") ?? 100),
    }),
  });
}

async function handlePATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/alerts">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  if (!(await getDeviceView(id))) return fail(404, "Device not found");

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const alertId = optionalString(parsed.body, "alertId", 64);
  if (!alertId) return fail(422, '"alertId" is required');

  const acknowledged = await acknowledgeAlert(
    alertId,
    optionalString(parsed.body, "userId", 64) ?? null,
  );
  if (!acknowledged) return fail(404, "Alert not found, or already acknowledged");

  await recordAudit({
    deviceId: id,
    action: "alert.acknowledged",
    detail: { alertId },
    ip: clientIp(request),
  });

  return ok({ acknowledged: true, alertId });
}

export const GET = withApiLog("/api/devices/[id]/alerts", handleGET);
export const PATCH = withApiLog("/api/devices/[id]/alerts", handlePATCH);
