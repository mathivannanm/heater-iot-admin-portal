import type { NextRequest } from "next/server";
import { authFailure, fail, ok } from "@/lib/api";
import { authenticateAdmin, authenticateDevice } from "@/lib/auth";
import { describeUpdateFor, getCurrentFirmware } from "@/lib/firmware";
import { getDeviceView } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/devices/:id/firmware - "is there an update for me?"
 *
 * Answered from the current release for the device's model. A board calls
 * this after receiving a FIRMWARE_UPDATE command (or on boot, if it prefers to
 * poll), compares `release.version` with what it is running, and downloads
 * from `downloadPath` when they differ. Accepts the device's own key, or an
 * admin key so an operator can see what a device would be told.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/firmware">,
): Promise<Response> {
  const { id } = await ctx.params;

  const deviceAuth = await authenticateDevice(request, id);
  if (!deviceAuth.ok) {
    const adminAuth = authenticateAdmin(request);
    if (!adminAuth.ok) return authFailure(deviceAuth);
  }

  const device = await getDeviceView(id);
  if (!device) return fail(404, "Device not found");

  const current = await getCurrentFirmware(device.model);
  return ok(describeUpdateFor(device, current));
}

export const GET = withApiLog("/api/devices/[id]/firmware", handleGET);
