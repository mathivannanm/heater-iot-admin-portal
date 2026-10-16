import type { NextRequest } from "next/server";
import { authFailure, ok } from "@/lib/api";
import { withApiLog } from "@/lib/api-log";
import { authenticateAdmin } from "@/lib/auth";
import { config } from "@/lib/config";
import { listSensors } from "@/lib/sensors";

/**
 * GET /api/sensors - every temperature / humidity sensor board with its newest
 * reading and whether it is online.
 *
 * `serverTime` and the timeout ship with the list so a client can keep the
 * "12s ago" labels and the Online badge moving between polls without trusting
 * its own clock to agree with the server's.
 */
async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const now = Date.now();
  return ok({
    sensors: await listSensors(now),
    serverTime: now,
    offlineTimeoutMs: config.sensor.offlineTimeoutMs,
  });
}

export const GET = withApiLog("/api/sensors", handleGET);
