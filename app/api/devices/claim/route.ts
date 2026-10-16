import type { NextRequest } from "next/server";
import {
  ValidationError,
  authFailure,
  fail,
  ok,
  optionalString,
  readJson,
  requiredString,
} from "@/lib/api";
import { authenticateAdmin, authenticateProvisioning, clientIp } from "@/lib/auth";
import { config } from "@/lib/config";
import { claimDevice, dismissClaimRequest, listClaimRequests, recordAudit } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * POST /api/devices/claim - a board asks for the device row that carries its
 * serial. Answers:
 *
 *   200 { paired: true,  deviceId, deviceKey, name, nextIntervalMs }  key issued (once)
 *   404 { paired: false, status: "not_added" }   nobody has added this serial yet
 *   409 { paired: false, status: "already_paired" }   another board holds the key
 *
 * The firmware retries a 404 slowly; the serial is remembered so the operator
 * sees it under "Boards waiting to join" on the Add device form.
 */
async function handlePOST(request: NextRequest): Promise<Response> {
  const auth = authenticateProvisioning(request);
  if (!auth.ok) return authFailure(auth);

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const result = await claimDevice({
      serialNumber: requiredString(body, "serialNumber", 64),
      firmwareVersion: optionalString(body, "firmwareVersion", 32) ?? null,
      model: optionalString(body, "model", 64) ?? null,
      bluetoothName: optionalString(body, "bluetoothName", 64) ?? null,
      bluetoothAddress: optionalString(body, "bluetoothAddress", 64) ?? null,
      homeSsid: optionalString(body, "homeSsid", 64) ?? null,
      localAddress: optionalString(body, "localAddress", 128) ?? null,
      ip: clientIp(request),
    });

    if (result.status === "unknown") {
      return fail(404, "This serial has not been added on the portal yet", {
        paired: false,
        status: "not_added",
      });
    }
    if (result.status === "already_paired") {
      return fail(409, "This device is already paired to a board; reset its pairing first", {
        paired: false,
        status: "already_paired",
        deviceId: result.device.id,
      });
    }

    await recordAudit({
      deviceId: result.device.id,
      action: "device.paired",
      detail: { serialNumber: result.device.serialNumber, actor: auth.actor },
      ip: clientIp(request),
    });

    // Flat on purpose: the firmware parses this with string searches, not a
    // JSON library. The key is returned exactly once.
    return ok({
      paired: true,
      deviceId: result.device.id,
      deviceKey: result.deviceKey,
      name: result.device.name,
      nextIntervalMs: config.telemetryIntervalMs,
    });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

/** GET /api/devices/claim - boards waiting to be added (admin). */
async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);
  return ok({ requests: await listClaimRequests() });
}

/** DELETE /api/devices/claim?serial=… - forget a waiting board (admin). */
async function handleDELETE(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);
  const serial = request.nextUrl.searchParams.get("serial")?.trim();
  if (!serial) return fail(422, '"serial" query parameter is required');
  const removed = await dismissClaimRequest(serial);
  if (!removed) return fail(404, "No waiting board with that serial");
  return ok({ removed: true });
}

export const POST = withApiLog("/api/devices/claim", handlePOST);
export const GET = withApiLog("/api/devices/claim", handleGET);
export const DELETE = withApiLog("/api/devices/claim", handleDELETE);
