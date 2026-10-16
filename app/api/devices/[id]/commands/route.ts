import type { NextRequest } from "next/server";
import {
  ValidationError,
  authFailure,
  fail,
  ok,
  optionalEnum,
  optionalString,
  readJson,
  requiredString,
} from "@/lib/api";
import { authenticateAdmin, authenticateDevice, clientIp } from "@/lib/auth";
import {
  claimPendingCommands,
  completeCommand,
  getDeviceView,
  issueCommand,
  listCommands,
  recordAudit,
} from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET   /api/devices/:id/commands - the queue (admin), or claim pending (device).
 * POST  /api/devices/:id/commands - queue a command (admin).
 * PATCH /api/devices/:id/commands - acknowledge or fail one (device).
 *
 * Commands are queued rather than pushed: the dashboard writes a row, and the
 * device collects it on its next round trip. A heater that is asleep or out of
 * range gets its command when it comes back, instead of the dashboard having to
 * hold a connection open to hardware that is not listening.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/commands">,
): Promise<Response> {
  const { id } = await ctx.params;

  // A device asking for its own queue claims the pending rows; an operator
  // asking is just reading history and must not consume anything.
  const deviceAuth = await authenticateDevice(request, id);
  if (deviceAuth.ok) {
    return ok({ commands: await claimPendingCommands(id) });
  }

  const adminAuth = authenticateAdmin(request);
  if (!adminAuth.ok) return authFailure(adminAuth);

  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  return ok({ commands: await listCommands(id, Number.isFinite(limit) ? limit : 50) });
}

async function handlePOST(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/commands">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const device = await getDeviceView(id);
  if (!device) return fail(404, "Device not found");

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  try {
    const command = requiredString(parsed.body, "command", 200);
    const issued = await issueCommand(id, command, optionalString(parsed.body, "issuedBy", 64) ?? null);
    if (!issued) return fail(404, "Device not found");

    await recordAudit({
      deviceId: id,
      action: "command.issued",
      detail: { command, commandId: issued.id },
      ip: clientIp(request),
    });

    // 202, not 201: the row exists, but nothing has reached the hardware yet.
    return ok({ command: issued, queued: true, deviceOnline: device.online }, { status: 202 });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

async function handlePATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/commands">,
): Promise<Response> {
  const { id } = await ctx.params;

  const auth = await authenticateDevice(request, id);
  if (!auth.ok) return authFailure(auth);

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  try {
    const commandId = requiredString(parsed.body, "commandId", 64);
    const status = optionalEnum(parsed.body, "status", ["acked", "failed"] as const) ?? "acked";

    const updated = await completeCommand(
      commandId,
      status,
      optionalString(parsed.body, "reply", 500) ?? null,
      optionalString(parsed.body, "error", 500) ?? null,
    );
    if (!updated) return fail(404, "Command not found");
    if (updated.deviceId !== id) return fail(403, "Command belongs to another device");

    return ok({ command: updated });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

export const GET = withApiLog("/api/devices/[id]/commands", handleGET);
export const POST = withApiLog("/api/devices/[id]/commands", handlePOST);
export const PATCH = withApiLog("/api/devices/[id]/commands", handlePATCH);
