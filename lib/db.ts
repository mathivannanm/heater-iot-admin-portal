import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

/**
 * Postgres connection for the `heaterfan` database.
 *
 * Every read and write in the application goes through this module. The pool
 * is cached on `globalThis` because Next.js re-evaluates modules on hot reload
 * in development, and a fresh pool per reload would exhaust the server's
 * connection slots within a few edits.
 */

// ---------------------------------------------------------------- type parsers
//
// node-postgres hands back strings for any type that cannot be represented
// exactly as a JavaScript number, which is correct in general and wrong for us:
// every current, power and temperature column is NUMERIC, and the dashboard
// does arithmetic on all of them. We opt into lossy-but-adequate parsing once,
// here, rather than sprinkling Number() over every call site and forgetting one.

types.setTypeParser(types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));
types.setTypeParser(types.builtins.INT8, (value) => (value === null ? null : Number(value)));

const connectionString =
  process.env.DATABASE_URL ??
  process.env.HEATER_DATABASE_URL ??
  "postgresql://heater@localhost:5432/heaterfan";

declare global {
  var __heaterPool: Pool | undefined;
}

function createPool(): Pool {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.HEATER_DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "heater-admin-dashboard",
  });

  // An idle client that dies (server restart, network blip) emits an error on
  // the pool rather than on any awaited query. Without this handler Node treats
  // it as an unhandled 'error' event and kills the process.
  pool.on("error", (error) => {
    console.error("[db] idle client error:", error.message);
  });

  return pool;
}

export function getPool(): Pool {
  if (!globalThis.__heaterPool) globalThis.__heaterPool = createPool();
  return globalThis.__heaterPool;
}

/** Runs a single statement on a pooled connection. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

/** Runs a statement expected to match at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw. Ingest writes a
 * telemetry frame, six channel rows and a device update together; a partial
 * write there would leave `devices.latest_telemetry_id` pointing at a frame
 * whose channels are missing.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already unusable; the pool will discard it.
    }
    throw error;
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------- row coercion
//
// Helpers for turning a pg row value into the shape the domain model wants.
// They exist because a NUMERIC column that is NULL, a timestamptz that is NULL
// and an absent column all arrive as `null` or `undefined`, and the difference
// matters at exactly one place: whether the dashboard renders a dash or a zero.

/** timestamptz -> epoch milliseconds. */
export function ms(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value as string).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** timestamptz -> epoch milliseconds, for a NOT NULL column. */
export function msRequired(value: unknown): number {
  return ms(value) ?? 0;
}

/** NUMERIC -> number | null, preserving null. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** NUMERIC -> number, for a NOT NULL column with a sensible zero. */
export function numRequired(value: unknown, fallback = 0): number {
  return num(value) ?? fallback;
}

/** inet / text -> string | null, trimming the empty strings the seed data uses. */
export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const asString = String(value).trim();
  return asString === "" ? null : asString;
}

/** Checks the connection and confirms the expected schema is present. */
export async function checkDatabase(): Promise<{
  ok: boolean;
  database: string | null;
  missingTables: string[];
  error: string | null;
}> {
  const expected = [
    "devices",
    "device_channels",
    "device_settings",
    "telemetry",
    "telemetry_channels",
    "alerts",
    "commands",
    "energy_hourly",
    "homes",
    "rooms",
    "users",
    "audit_log",
    "firmware_releases",
    "api_requests",
    "device_claim_requests",
    "sensor_settings",
    "sensor_alerts",
  ];

  try {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [expected],
    );
    const present = new Set(rows.map((row) => row.table_name));
    const database = await queryOne<{ name: string }>("SELECT current_database() AS name");
    return {
      ok: present.size === expected.length,
      database: database?.name ?? null,
      missingTables: expected.filter((name) => !present.has(name)),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      database: null,
      missingTables: expected,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
