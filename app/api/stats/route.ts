import type { NextRequest } from "next/server";
import { authFailure, ok } from "@/lib/api";
import { authenticateAdmin, adminAuthConfigured } from "@/lib/auth";
import { config } from "@/lib/config";
import { getStats } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/stats - fleet counters, plus the thresholds they were derived from.
 *
 * The thresholds ship with the numbers so a reader can tell what "offline"
 * actually meant when the counters were computed, rather than having to guess
 * at the server's configuration.
 */
async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  return ok({
    stats: await getStats(),
    thresholds: {
      offlineTimeoutMs: config.offlineTimeoutMs,
      staleDataMs: config.staleDataMs,
      telemetryIntervalMs: config.telemetryIntervalMs,
    },
    security: { adminAuthConfigured: adminAuthConfigured() },
  });
}

export const GET = withApiLog("/api/stats", handleGET);
