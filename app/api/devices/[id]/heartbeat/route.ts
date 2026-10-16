import type { NextRequest } from "next/server";
import { authFailure, fail, ok } from "@/lib/api";
import { authenticateDevice } from "@/lib/auth";
import { claimPendingCommands, touchDevice } from "@/lib/store";
import { config } from "@/lib/config";
import { withApiLog } from "@/lib/api-log";

/**
 * POST /api/devices/:id/heartbeat
 *
 * Proof of life without a full frame. A board that is idle - nothing switched
 * on, nothing changing - still has to say so, otherwise the sweeper would mark
 * it offline. This only advances `devices.last_seen_at`; it writes no telemetry
 * row, because an idle heater posting identical frames every fifteen seconds
 * would bury the readings that actually mean something.
 */
async function handlePOST(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/heartbeat">,
): Promise<Response> {
  const { id } = await ctx.params;

  const auth = await authenticateDevice(request, id);
  if (!auth.ok) return authFailure(auth);

  const device = await touchDevice(id);
  if (!device) return fail(404, "Device not found");

  return ok({
    accepted: true,
    receivedAt: Date.now(),
    nextIntervalMs: config.telemetryIntervalMs,
    commands: await claimPendingCommands(id),
  });
}

export const POST = withApiLog("/api/devices/[id]/heartbeat", handlePOST);
