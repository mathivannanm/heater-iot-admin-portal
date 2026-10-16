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
import { listDevices, recordAudit, registerDevice, type ListOptions } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/devices - the device index behind the dashboard table.
 * POST /api/devices - firmware self-registration.
 */
async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const params = request.nextUrl.searchParams;
  const options: ListOptions = {
    search: params.get("search") ?? undefined,
    status: (params.get("status") as ListOptions["status"]) ?? "all",
    connection: (params.get("connection") as ListOptions["connection"]) ?? "all",
    kind: (params.get("kind") as ListOptions["kind"]) ?? "all",
    room: params.get("room") ?? undefined,
    sortBy: (params.get("sortBy") as ListOptions["sortBy"]) ?? "name",
    sortDir: (params.get("sortDir") as ListOptions["sortDir"]) ?? "asc",
    page: Number(params.get("page") ?? 1),
    pageSize: Number(params.get("pageSize") ?? 20),
  };

  return ok(await listDevices(options));
}

async function handlePOST(request: NextRequest): Promise<Response> {
  const auth = authenticateProvisioning(request);
  if (!auth.ok) return authFailure(auth);

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const result = await registerDevice({
      name: requiredString(body, "name", 80),
      serialNumber: requiredString(body, "serialNumber", 64),
      firmwareVersion: optionalString(body, "firmwareVersion", 32) ?? null,
      model: optionalString(body, "model", 64) ?? undefined,
      bluetoothName: optionalString(body, "bluetoothName", 64) ?? undefined,
      bluetoothAddress: optionalString(body, "bluetoothAddress", 64) ?? null,
      homeSsid: optionalString(body, "homeSsid", 64) ?? null,
      localAddress: optionalString(body, "localAddress", 128) ?? null,
      roomId: optionalString(body, "roomId", 64) ?? null,
      deviceKey: optionalString(body, "deviceKey", 128) ?? undefined,
    });

    if (!result) {
      return fail(409, "No home exists to attach this device to");
    }

    await recordAudit({
      deviceId: result.device.id,
      action: result.created ? "device.registered" : "device.reregistered",
      detail: { serialNumber: result.device.serialNumber, actor: auth.actor },
      ip: clientIp(request),
    });

    // The plaintext key is returned exactly once, at registration. Only its
    // SHA-256 is stored, so it cannot be recovered later - a device that loses
    // its key has to be re-registered rather than looked up.
    return ok(
      {
        device: result.device,
        deviceKey: result.deviceKey,
        created: result.created,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

export const GET = withApiLog("/api/devices", handleGET);
export const POST = withApiLog("/api/devices", handlePOST);
