import type { NextRequest } from "next/server";
import { ValidationError, authFailure, fail, ok, optionalEnum, optionalString, readJson } from "@/lib/api";
import { NAME_SOURCES } from "@/lib/types";
import { authenticateAdmin, clientIp } from "@/lib/auth";
import {
  getDeviceView,
  listAlerts,
  listAudit,
  listCommands,
  recordAudit,
  removeDevice,
  updateDevice,
} from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET    /api/devices/:id - full device view plus its recent activity.
 * PATCH  /api/devices/:id - rename, hand the name back to the board, or move to another room.
 * DELETE /api/devices/:id - decommission (cascades to telemetry and alerts).
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const device = await getDeviceView(id);
  if (!device) return fail(404, "Device not found");

  const [alerts, commands, audit] = await Promise.all([
    listAlerts({ deviceId: id, limit: 50 }),
    listCommands(id, 25),
    listAudit({ deviceId: id, limit: 25 }),
  ]);

  return ok({ device, alerts, commands, audit });
}

async function handlePATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  try {
    const patch: Parameters<typeof updateDevice>[1] = {};
    if ("name" in parsed.body) {
      const name = optionalString(parsed.body, "name", 80);
      if (!name) throw new ValidationError('"name" must be a non-empty string');
      patch.name = name;
    }
    // "device" hands the name back to the board (its next frame renames the
    // device); "portal" pins the current name. A rename alone implies "portal".
    const nameSource = optionalEnum(parsed.body, "nameSource", NAME_SOURCES);
    if (nameSource) patch.nameSource = nameSource;
    if ("roomId" in parsed.body) patch.roomId = optionalString(parsed.body, "roomId", 64) ?? null;
    if ("firmwareVersion" in parsed.body) {
      patch.firmwareVersion = optionalString(parsed.body, "firmwareVersion", 32) ?? null;
    }

    const device = await updateDevice(id, patch);
    if (!device) return fail(404, "Device not found");

    await recordAudit({
      deviceId: id,
      action: "device.updated",
      detail: patch as Record<string, unknown>,
      ip: clientIp(request),
    });

    return ok({ device });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

async function handleDELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;

  // Audited before the delete: the foreign key from audit_log to devices is
  // ON DELETE CASCADE, so a row written afterwards would take the audit trail
  // with it - the one record you most want to keep.
  const device = await getDeviceView(id);
  if (!device) return fail(404, "Device not found");
  await recordAudit({
    action: "device.removed",
    detail: { id, name: device.name, serialNumber: device.serialNumber },
    ip: clientIp(request),
  });

  const removed = await removeDevice(id);
  if (!removed) return fail(404, "Device not found");
  return ok({ removed: true, id });
}

export const GET = withApiLog("/api/devices/[id]", handleGET);
export const PATCH = withApiLog("/api/devices/[id]", handlePATCH);
export const DELETE = withApiLog("/api/devices/[id]", handleDELETE);
