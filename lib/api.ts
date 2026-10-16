import type { AuthFailure } from "./auth";
import { DAY_MS, startOfDayInZone } from "./clock";
import { displayTimezone } from "./config";

/** JSON helpers shared by every route handler. */

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data as object, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function fail(status: number, error: string, detail?: unknown): Response {
  return Response.json(
    { error, ...(detail === undefined ? {} : { detail }) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function authFailure(result: AuthFailure): Response {
  return fail(result.status, result.error);
}

export async function readJson(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const parsed = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, response: fail(400, "Request body must be a JSON object") };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: fail(400, "Request body is not valid JSON") };
  }
}

// ------------------------------------------------------------------ coercion

/**
 * Field readers that distinguish "absent" (leave the stored value alone) from
 * "explicitly null" (clear it). Anything malformed is rejected rather than
 * silently coerced, so bad firmware cannot poison the dashboard.
 */

export class ValidationError extends Error {}

export function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  bounds?: { min?: number; max?: number },
): number | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`"${key}" must be a finite number or null`);
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    throw new ValidationError(`"${key}" must be >= ${bounds.min}`);
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    throw new ValidationError(`"${key}" must be <= ${bounds.max}`);
  }
  return value;
}

export function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "boolean") throw new ValidationError(`"${key}" must be a boolean or null`);
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  maxLength = 200,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`"${key}" must be a string or null`);
  if (value.length > maxLength) throw new ValidationError(`"${key}" exceeds ${maxLength} characters`);
  return value;
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  maxLength = 200,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`"${key}" is required`);
  }
  if (value.length > maxLength) throw new ValidationError(`"${key}" exceeds ${maxLength} characters`);
  return value.trim();
}

export function optionalEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`"${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Reads an array of channel objects from a telemetry payload.
 *
 * The firmware sends one entry per relay it actually has, so an absent array
 * and an empty array both mean "this frame carries no per-channel data" rather
 * than "every channel is off" - the difference matters because writing zeros
 * for a channel the board never mentioned would fabricate a reading.
 */
export function optionalObjectArray(
  body: Record<string, unknown>,
  key: string,
  maxLength = 16,
): Record<string, unknown>[] | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`"${key}" must be an array`);
  if (value.length > maxLength) {
    throw new ValidationError(`"${key}" may contain at most ${maxLength} entries`);
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ValidationError(`"${key}[${index}]" must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

/** Reads a required integer, used for channel indices. */
export function requiredInteger(
  body: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number },
): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`"${key}" must be an integer`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new ValidationError(`"${key}" must be between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

// --------------------------------------------------------------- time ranges

export type RangeKey = "today" | "24h" | "7d" | "30d" | "custom";

/**
 * Resolves the dashboard's history filters into an absolute window.
 *
 * `today` is the whole calendar day in the display timezone, 00:00 to 24:00,
 * so the charts show the full day with the hours still to come left blank.
 * The server's own zone is irrelevant: the viewer reads Asia/Kolkata and so
 * must the window, or the day appears to start at 05:30.
 */
export function resolveRange(
  params: URLSearchParams,
  now: number = Date.now(),
): { from: number; to: number; range: RangeKey } {
  const range = (params.get("range") ?? "24h") as RangeKey;

  if (range === "custom") {
    const from = Number(params.get("from"));
    const to = Number(params.get("to"));
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
      return { from, to, range };
    }
    // Fall through to the default window when the custom bounds are unusable.
  }

  switch (range) {
    case "today": {
      const from = startOfDayInZone(now, displayTimezone);
      return { from, to: from + DAY_MS, range: "today" };
    }
    case "7d":
      return { from: now - 7 * 24 * 60 * 60 * 1000, to: now, range: "7d" };
    case "30d":
      return { from: now - 30 * 24 * 60 * 60 * 1000, to: now, range: "30d" };
    case "24h":
    default:
      return { from: now - 24 * 60 * 60 * 1000, to: now, range: "24h" };
  }
}
