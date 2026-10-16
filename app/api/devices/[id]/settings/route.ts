import type { NextRequest } from "next/server";
import {
  ValidationError,
  authFailure,
  fail,
  ok,
  optionalBoolean,
  optionalNumber,
  optionalString,
  readJson,
} from "@/lib/api";
import { authenticateAdmin, clientIp } from "@/lib/auth";
import { getDeviceView, recordAudit, updateSettings } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET   /api/devices/:id/settings - protection limits and climate configuration.
 * PATCH /api/devices/:id/settings - change them.
 *
 * These are the limits the ingest layer measures each frame against, so an
 * operator lowering a current limit immediately changes what raises an alert.
 * The device is told separately, via a command - writing the row here does not
 * reprogram the hardware, and the UI says so.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/settings">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const device = await getDeviceView(id);
  if (!device) return fail(404, "Device not found");

  return ok({ settings: device.settings });
}

async function handlePATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/settings">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  if (!(await getDeviceView(id))) return fail(404, "Device not found");

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const patch: Parameters<typeof updateSettings>[1] = {};

    // Bounds mirror the CHECK constraints in the schema, so an out-of-range
    // value is refused with a readable message instead of a Postgres error.
    const currentLimitA = optionalNumber(body, "currentLimitA", { min: 0, max: 200 });
    if (currentLimitA != null) patch.currentLimitA = currentLimitA;

    const totalLimitA = optionalNumber(body, "totalLimitA", { min: 0, max: 200 });
    if (totalLimitA != null) patch.totalLimitA = totalLimitA;

    const temperatureLimitC = optionalNumber(body, "temperatureLimitC", { min: 0, max: 300 });
    if (temperatureLimitC != null) patch.temperatureLimitC = temperatureLimitC;

    const mainsVoltageV = optionalNumber(body, "mainsVoltageV", { min: 0, max: 500 });
    if (mainsVoltageV != null) patch.mainsVoltageV = mainsVoltageV;

    const climateTargetC = optionalNumber(body, "climateTargetC", { min: 10, max: 35 });
    if (climateTargetC != null) patch.climateTargetC = climateTargetC;

    const autoFan = optionalBoolean(body, "autoFan");
    if (autoFan != null) patch.autoFan = autoFan;

    const climateEnabled = optionalBoolean(body, "climateEnabled");
    if (climateEnabled != null) patch.climateEnabled = climateEnabled;

    if (Object.keys(patch).length === 0) {
      return fail(422, "No recognised settings were supplied");
    }

    const settings = await updateSettings(
      id,
      patch,
      optionalString(body, "userId", 64) ?? null,
    );

    await recordAudit({
      deviceId: id,
      action: "settings.updated",
      detail: patch as Record<string, unknown>,
      ip: clientIp(request),
    });

    return ok({ settings });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

export const GET = withApiLog("/api/devices/[id]/settings", handleGET);
export const PATCH = withApiLog("/api/devices/[id]/settings", handlePATCH);
