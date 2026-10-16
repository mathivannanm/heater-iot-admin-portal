import type { NextRequest } from "next/server";
import { authFailure, fail, ok } from "@/lib/api";
import { authenticateAdmin, clientIp } from "@/lib/auth";
import { getDeviceView, recordAudit, resetDevicePairing } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * DELETE /api/devices/{id}/pairing - forget the device key so the next board
 * that presents this serial is paired. The board currently holding the old
 * key gets 403 on its next post, drops the key and claims again - which is
 * exactly what a replaced or re-flashed board needs.
 */
async function handleDELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/pairing">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const existing = await getDeviceView(id);
  if (!existing) return fail(404, "Device not found");

  const device = await resetDevicePairing(id);
  if (!device) return fail(404, "Device not found");

  await recordAudit({
    deviceId: id,
    action: "device.pairing_reset",
    detail: { serialNumber: device.serialNumber, actor: auth.actor },
    ip: clientIp(request),
  });

  return ok({ device });
}

export const DELETE = withApiLog("/api/devices/[id]/pairing", handleDELETE);
