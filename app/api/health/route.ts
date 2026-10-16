import { ok } from "@/lib/api";
import { checkDatabase } from "@/lib/db";
import { adminAuthConfigured } from "@/lib/auth";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/health - liveness for deployment checks.
 *
 * Unauthenticated on purpose, and deliberately terse: it reports whether the
 * database answers and whether the expected tables are there, without leaking
 * connection strings, credentials or row counts to an anonymous caller.
 */
async function handleGET(): Promise<Response> {
  const database = await checkDatabase();

  return ok(
    {
      status: database.ok ? "ok" : "degraded",
      database: {
        connected: database.error === null,
        name: database.database,
        schemaComplete: database.ok,
        missingTables: database.missingTables,
      },
      adminAuthConfigured: adminAuthConfigured(),
      t: Date.now(),
    },
    { status: database.ok ? 200 : 503 },
  );
}

export const GET = withApiLog("/api/health", handleGET);
