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
import { authenticateAdmin, clientIp } from "@/lib/auth";
import { addDevice, recordAudit } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * POST /api/devices/add - an operator adds a device from the dashboard.
 *
 * The row is created without a device key. The board that carries this serial
 * claims it on its next boot (POST /api/devices/claim) and only then can post
 * telemetry. This is the "same firmware on every board" flow: nothing is
 * compiled per device, the serial comes from the ESP32 MAC.
 */
async function handlePOST(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const serialNumber = requiredString(body, "serialNumber", 64);
    if (!/^[A-Za-z0-9._:-]+$/.test(serialNumber)) {
      return fail(422, '"serialNumber" may only contain letters, digits, ".", "_", ":" and "-"');
    }

    const result = await addDevice({
      name: requiredString(body, "name", 80),
      serialNumber,
      model: optionalString(body, "model", 64) ?? null,
      roomId: optionalString(body, "roomId", 64) ?? null,
    });

    if (!result.ok) {
      if (result.reason === "serial_exists") {
        return fail(409, "A device with this serial number already exists", {
          deviceId: result.device?.id ?? null,
          name: result.device?.name ?? null,
        });
      }
      return fail(409, "No home exists to attach this device to");
    }

    await recordAudit({
      deviceId: result.device.id,
      action: "device.added",
      detail: { serialNumber: result.device.serialNumber, actor: auth.actor },
      ip: clientIp(request),
    });

    return ok({ device: result.device, created: true }, { status: 201 });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

export const POST = withApiLog("/api/devices/add", handlePOST);
