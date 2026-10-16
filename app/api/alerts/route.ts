import type { NextRequest } from "next/server";
import { authFailure, ok, resolveRange } from "@/lib/api";
import { authenticateAdmin } from "@/lib/auth";
import { listAlerts } from "@/lib/store";
import type { AlertSeverity } from "@/lib/types";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/alerts - the fleet-wide fault log behind the alerts page.
 *
 * Defaults to open alerts across all devices, which is what an operator opening
 * the page wants to see first; `open=false` returns the resolved history.
 */
async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const params = request.nextUrl.searchParams;
  const openParam = params.get("open");
  const scoped = params.has("range") || params.has("from");
  const { from, to } = resolveRange(params);

  return ok({
    alerts: await listAlerts({
      open: openParam === null ? undefined : openParam !== "false",
      severity: (params.get("severity") as AlertSeverity | null) ?? undefined,
      deviceId: params.get("deviceId") ?? undefined,
      // An unbounded query would silently hide alerts older than the default
      // window, so the range only applies when the caller asked for one.
      from: scoped ? from : undefined,
      to: scoped ? to : undefined,
      limit: Number(params.get("limit") ?? 200),
    }),
  });
}

export const GET = withApiLog("/api/alerts", handleGET);
