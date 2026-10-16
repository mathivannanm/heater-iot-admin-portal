import type { NextRequest } from "next/server";
import {
  ValidationError,
  authFailure,
  fail,
  ok,
  optionalNumber,
  optionalString,
  readJson,
} from "@/lib/api";
import { withApiLog } from "@/lib/api-log";
import { authenticateAdmin, clientIp } from "@/lib/auth";
import {
  SENSOR_KEYS,
  SENSOR_LABEL_MAX_LENGTH,
  SensorSettingsError,
  getSensor,
  updateSensorSettings,
  type SensorSettingsPatch,
} from "@/lib/sensors";
import { recordAudit } from "@/lib/store";

/**
 * GET   /api/sensors/:id/settings - alert thresholds and sensor labels.
 * PATCH /api/sensors/:id/settings - change them.
 *
 * A threshold of `null` removes the limit. These are the limits every frame is
 * measured against on ingest, so changing one changes what raises an alert
 * from the next reading onwards.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/sensors/[id]/settings">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const sensor = await getSensor(id);
  if (!sensor) return fail(404, "Sensor not found");

  return ok({ settings: sensor.settings });
}

async function handlePATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/sensors/[id]/settings">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const patch: SensorSettingsPatch = {};

    // Bounds are the sensors' physical range, as on the ingest endpoint.
    for (const key of ["tempHighC", "tempLowC"] as const) {
      if (key in body) patch[key] = optionalNumber(body, key, { min: -55, max: 300 }) ?? null;
    }
    for (const key of ["humidityHighPct", "humidityLowPct"] as const) {
      if (key in body) patch[key] = optionalNumber(body, key, { min: 0, max: 100 }) ?? null;
    }

    if ("labels" in body) {
      const labels = body.labels;
      if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
        throw new ValidationError('"labels" must be an object');
      }
      patch.labels = {};
      for (const [key, value] of Object.entries(labels)) {
        if (!(SENSOR_KEYS as readonly string[]).includes(key)) {
          throw new ValidationError(`"labels.${key}" is not a sensor; expected one of: ${SENSOR_KEYS.join(", ")}`);
        }
        const label = optionalString({ [`labels.${key}`]: value }, `labels.${key}`, SENSOR_LABEL_MAX_LENGTH);
        patch.labels[key as (typeof SENSOR_KEYS)[number]] = label ?? null;
      }
    }

    if (Object.keys(patch).length === 0) {
      return fail(422, "No recognised settings were supplied");
    }

    const settings = await updateSensorSettings(id, patch);
    if (!settings) return fail(404, "Sensor not found");

    await recordAudit({
      deviceId: id,
      action: "sensor.settings.updated",
      detail: patch as Record<string, unknown>,
      ip: clientIp(request),
    });

    return ok({ settings });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SensorSettingsError) {
      return fail(422, error.message);
    }
    throw error;
  }
}

export const GET = withApiLog("/api/sensors/[id]/settings", handleGET);
export const PATCH = withApiLog("/api/sensors/[id]/settings", handlePATCH);
