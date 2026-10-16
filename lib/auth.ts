import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { queryOne } from "./db";
import { hashDeviceKey, isUuid } from "./store";

/** Constant-time comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return null;
}

export type AuthFailure = { ok: false; status: 401 | 403; error: string };
export type DeviceAuthSuccess = { ok: true; deviceId: string };
export type AdminAuthSuccess = { ok: true; actor: string };

/**
 * Cookie the browser dashboard carries the admin key in, set by
 * `POST /api/auth/login`. Every server-rendered admin page and API route
 * checks the same name, so signing in once covers both.
 */
export const ADMIN_COOKIE_NAME = "heater_admin";

/** True when `candidate` is the configured admin key. Used by the login route. */
export function verifyAdminKey(candidate: string): boolean {
  return config.adminKey.length > 0 && safeEqual(candidate, config.adminKey);
}

/**
 * Authenticates a device against `devices.device_key_hash`.
 *
 * The database stores only the SHA-256 of the key, so a dump of the devices
 * table does not hand an attacker the credentials to impersonate a heater. We
 * hash what was presented and compare digests; the plaintext key exists only on
 * the device and in the response to the registration call that minted it.
 */
export async function authenticateDevice(
  request: Request,
  deviceId: string,
): Promise<DeviceAuthSuccess | AuthFailure> {
  const presented = request.headers.get("x-device-key") ?? bearer(request);
  if (!presented) return { ok: false, status: 401, error: "Missing device credentials" };
  if (!isUuid(deviceId)) return { ok: false, status: 403, error: "Invalid device credentials" };

  const row = await queryOne<{ device_key_hash: string | null }>(
    `SELECT device_key_hash FROM devices WHERE id = $1`,
    [deviceId],
  );

  // A missing device and a wrong key fail identically, so an unauthenticated
  // caller cannot use the response to enumerate which device ids exist.
  if (!row?.device_key_hash) {
    return { ok: false, status: 403, error: "Invalid device credentials" };
  }
  if (!safeEqual(hashDeviceKey(presented), row.device_key_hash)) {
    return { ok: false, status: 403, error: "Invalid device credentials" };
  }
  return { ok: true, deviceId };
}

/** Provisioning secret, required before a new heater can join the fleet. */
export function authenticateProvisioning(request: Request): AdminAuthSuccess | AuthFailure {
  if (!config.provisioningKey) {
    // Unset in local development so a bench board can enrol itself. Set
    // HEATER_PROVISIONING_KEY in any shared environment.
    return { ok: true, actor: "unauthenticated-provisioning" };
  }
  const presented = request.headers.get("x-provisioning-key") ?? bearer(request);
  if (!presented || !safeEqual(presented, config.provisioningKey)) {
    return { ok: false, status: 401, error: "Invalid provisioning key" };
  }
  return { ok: true, actor: "provisioning" };
}

/**
 * Mobile-app credential for the firmware endpoints. The app is neither a
 * device (it has no per-device key of its own) nor an operator, so it gets a
 * third secret. An admin key is accepted too, so the portal and curl can
 * exercise the same routes. Unset = open (development only).
 */
export function authenticateApp(request: Request): AdminAuthSuccess | AuthFailure {
  if (!config.appKey) return { ok: true, actor: "unauthenticated-app" };

  const presented = request.headers.get("x-app-key") ?? bearer(request);
  if (presented && safeEqual(presented, config.appKey)) return { ok: true, actor: "app" };

  const admin = authenticateAdmin(request);
  if (admin.ok) return admin;

  return { ok: false, status: 401, error: "Invalid app key" };
}

/**
 * Admin/dashboard APIs. When HEATER_ADMIN_KEY is unset the API is open, which
 * is fine on a laptop and must not be relied on anywhere else - the dashboard
 * surfaces a banner in that case.
 */
export function authenticateAdmin(request: Request): AdminAuthSuccess | AuthFailure {
  if (!config.adminKey) return { ok: true, actor: "local-admin" };

  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE_NAME}=`))
    ?.slice(`${ADMIN_COOKIE_NAME}=`.length);

  const presented = request.headers.get("x-admin-key") ?? bearer(request) ?? cookie;
  if (!presented || !safeEqual(presented, config.adminKey)) {
    return { ok: false, status: 401, error: "Admin authentication required" };
  }
  return { ok: true, actor: "admin" };
}

export const adminAuthConfigured = () => config.adminKey.length > 0;

/** Client IP for the audit log, honouring the usual proxy headers. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip");
}
