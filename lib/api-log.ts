import type { NextRequest } from "next/server";
import { config } from "./config";
import { ms, msRequired, query } from "./db";

/**
 * Request log for the HTTP API.
 *
 * Every route handler is wrapped with `withApiLog(route, handler)`. The
 * wrapper times the call, works out what kind of credential was presented,
 * pulls the device id out of the path when there is one, and writes a row to
 * `api_requests` after the response has been produced - never before, and
 * never awaited on the request path, so logging cannot slow a telemetry frame
 * down or turn a working ingest into a 500 because the log table is full.
 *
 * `credential` records what was *presented*, not what was verified: a device
 * posting with a wrong key shows as `device` with a 403, which is exactly the
 * pattern an operator is looking for when a board "isn't showing up".
 */

export type Credential = "admin" | "device" | "app" | "provisioning" | "bearer" | "none";

export interface ApiRequestEntry {
  id: number;
  method: string;
  route: string;
  path: string;
  query: string | null;
  status: number;
  durationMs: number;
  credential: Credential;
  deviceId: string | null;
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  error: string | null;
  createdAt: number;
}

type Handler<C> = (request: NextRequest, ctx: C) => Promise<Response> | Response;

const DEVICE_PATH = /^\/api\/(?:devices|sensors)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

function credentialOf(request: Request): Credential {
  const has = (name: string) => request.headers.get(name) !== null;
  if (has("x-device-key")) return "device";
  if (has("x-admin-key")) return "admin";
  if (has("x-app-key")) return "app";
  if (has("x-provisioning-key")) return "provisioning";
  if (request.headers.get("authorization")?.toLowerCase().startsWith("bearer ")) return "bearer";
  if (request.headers.get("cookie")?.includes("heater_admin=")) return "admin";
  return "none";
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip");
}

/** The `error` field of a JSON failure body, if the response has one. Small bodies only. */
async function errorOf(response: Response): Promise<string | null> {
  if (response.status < 400) return null;
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error.slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * Wraps a route handler so the call is logged. `route` is the file-system
 * pattern (`/api/devices/[id]/telemetry`), so calls to the same endpoint
 * group together no matter which device id was in the path.
 */
export function withApiLog<C>(route: string, handler: Handler<C>): Handler<C> {
  return async (request, ctx) => {
    const startedAt = Date.now();
    const started = process.hrtime.bigint();

    let response: Response;
    try {
      response = await handler(request, ctx);
    } catch (error) {
      record(request, route, startedAt, started, 500, error instanceof Error ? error.message : String(error));
      throw error;
    }

    record(request, route, startedAt, started, response.status, await errorOf(response));
    return response;
  };
}

let lastPruneAt = 0;

function record(
  request: NextRequest,
  route: string,
  startedAt: number,
  started: bigint,
  status: number,
  error: string | null,
): void {
  if (!config.apiLog.enabled) return;

  const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  const url = request.nextUrl;
  const credential = credentialOf(request);
  const deviceId = DEVICE_PATH.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
  const search = url.search ? url.search.slice(1) : null;

  if (config.apiLog.console) {
    const suffix = error ? ` - ${error}` : "";
    console.log(
      `[api] ${request.method} ${url.pathname}${url.search} ${status} ${durationMs}ms credential=${credential}${suffix}`,
    );
  }

  void query(
    `INSERT INTO api_requests
       (method, route, path, query, status, duration_ms, credential, device_id, ip, user_agent, error, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      request.method,
      route,
      url.pathname,
      search?.slice(0, 2000) ?? null,
      status,
      durationMs,
      credential,
      deviceId,
      clientIp(request),
      request.headers.get("user-agent")?.slice(0, 500) ?? null,
      error,
      new Date(startedAt),
    ],
  ).catch((caught: unknown) => {
    // The log is a convenience; the request it describes already succeeded.
    console.error("[api] could not write request log:", caught instanceof Error ? caught.message : caught);
  });

  if (startedAt - lastPruneAt > 60 * 60 * 1000) {
    lastPruneAt = startedAt;
    void pruneApiRequests(startedAt).catch(() => {});
  }
}

export async function pruneApiRequests(now: number = Date.now()): Promise<number> {
  const rows = await query(
    `DELETE FROM api_requests WHERE created_at < $1 RETURNING id`,
    [new Date(now - config.apiLog.retentionMs)],
  );
  return rows.length;
}

// -------------------------------------------------------------------- reads

export interface ApiLogOptions {
  route?: string;
  method?: string;
  credential?: Credential;
  deviceId?: string;
  /** Only failures (status >= 400). */
  failed?: boolean;
  status?: number;
  from?: number;
  to?: number;
  limit?: number;
}

interface Row {
  id: number;
  method: string;
  route: string;
  path: string;
  query: string | null;
  status: number;
  duration_ms: number;
  credential: Credential;
  device_id: string | null;
  device_name: string | null;
  ip: string | null;
  user_agent: string | null;
  error: string | null;
  created_at: Date;
}

function where(options: ApiLogOptions, params: unknown[]): string {
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (options.route) add("r.route = ?", options.route);
  if (options.method) add("r.method = ?", options.method.toUpperCase());
  if (options.credential) add("r.credential = ?", options.credential);
  if (options.deviceId) add("r.device_id = ?", options.deviceId);
  if (options.status !== undefined) add("r.status = ?", options.status);
  else if (options.failed) clauses.push("r.status >= 400");
  if (options.from !== undefined) add("r.created_at >= ?", new Date(options.from));
  if (options.to !== undefined) add("r.created_at <= ?", new Date(options.to));
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export async function listApiRequests(options: ApiLogOptions = {}): Promise<ApiRequestEntry[]> {
  const params: unknown[] = [];
  const filter = where(options, params);
  params.push(Math.min(Math.max(options.limit ?? 100, 1), 1000));

  const rows = await query<Row>(
    `SELECT r.*, d.name AS device_name
     FROM api_requests r
     LEFT JOIN devices d ON d.id = r.device_id
     ${filter}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    method: row.method,
    route: row.route,
    path: row.path,
    query: row.query,
    status: row.status,
    durationMs: row.duration_ms,
    credential: row.credential,
    deviceId: row.device_id,
    deviceName: row.device_name,
    ip: row.ip,
    userAgent: row.user_agent,
    error: row.error,
    createdAt: msRequired(row.created_at),
  }));
}

export interface ApiRouteSummary {
  method: string;
  route: string;
  calls: number;
  failed: number;
  avgDurationMs: number;
  maxDurationMs: number;
  lastCalledAt: number | null;
  lastStatus: number | null;
}

/** Per-route counters for a window: the quickest answer to "is X being called?". */
export async function summarizeApiRequests(
  options: Pick<ApiLogOptions, "from" | "to" | "deviceId" | "credential"> = {},
): Promise<ApiRouteSummary[]> {
  const params: unknown[] = [];
  const filter = where(options, params);

  const rows = await query<{
    method: string;
    route: string;
    calls: number;
    failed: number;
    avg_ms: number | null;
    max_ms: number | null;
    last_at: Date | null;
    last_status: number | null;
  }>(
    `SELECT r.method, r.route,
            count(*)::int AS calls,
            count(*) FILTER (WHERE r.status >= 400)::int AS failed,
            round(avg(r.duration_ms))::int AS avg_ms,
            max(r.duration_ms)::int AS max_ms,
            max(r.created_at) AS last_at,
            (array_agg(r.status ORDER BY r.created_at DESC, r.id DESC))[1] AS last_status
     FROM api_requests r
     ${filter}
     GROUP BY r.method, r.route
     ORDER BY calls DESC, r.route`,
    params,
  );

  return rows.map((row) => ({
    method: row.method,
    route: row.route,
    calls: row.calls,
    failed: row.failed,
    avgDurationMs: row.avg_ms ?? 0,
    maxDurationMs: row.max_ms ?? 0,
    lastCalledAt: ms(row.last_at),
    lastStatus: row.last_status,
  }));
}
