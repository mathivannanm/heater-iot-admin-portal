import type { NextRequest } from "next/server";
import { authFailure, fail, ok, resolveRange } from "@/lib/api";
import { authenticateAdmin } from "@/lib/auth";
import { listApiRequests, summarizeApiRequests, withApiLog, type Credential } from "@/lib/api-log";

/**
 * GET /api/logs - the API request log.
 *
 * `?view=summary` (default) answers "which endpoints have been called, how
 * often, and when last?" for the window. `?view=calls` lists individual
 * requests, newest first, with the same filters. Both default to the last 24
 * hours; pass `range=today|24h|7d|30d|custom&from=&to=` to change it.
 */
const CREDENTIALS = new Set<Credential>(["admin", "device", "app", "provisioning", "bearer", "none"]);

export const GET = withApiLog("/api/logs", async (request: NextRequest): Promise<Response> => {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const params = request.nextUrl.searchParams;
  const { from, to, range } = resolveRange(params);

  const credentialParam = params.get("credential");
  if (credentialParam && !CREDENTIALS.has(credentialParam as Credential)) {
    return fail(422, `"credential" must be one of: ${[...CREDENTIALS].join(", ")}`);
  }
  const credential = (credentialParam as Credential | null) ?? undefined;
  const deviceId = params.get("deviceId") ?? undefined;

  const view = params.get("view") ?? "summary";
  if (view === "summary") {
    const routes = await summarizeApiRequests({ from, to, deviceId, credential });
    const calls = routes.reduce((sum, row) => sum + row.calls, 0);
    const failed = routes.reduce((sum, row) => sum + row.failed, 0);
    return ok({ range, from, to, calls, failed, routes });
  }
  if (view !== "calls") return fail(422, '"view" must be "summary" or "calls"');

  const statusParam = params.get("status");
  const status = statusParam === null ? undefined : Number(statusParam);
  if (status !== undefined && !Number.isInteger(status)) return fail(422, '"status" must be an integer');

  const calls = await listApiRequests({
    from,
    to,
    deviceId,
    credential,
    route: params.get("route") ?? undefined,
    method: params.get("method") ?? undefined,
    status,
    failed: params.get("failed") === "true",
    limit: Number(params.get("limit") ?? 100),
  });
  return ok({ range, from, to, calls });
});
