import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { fail, ok, readJson, requiredString, ValidationError } from "@/lib/api";
import { withApiLog } from "@/lib/api-log";
import { ADMIN_COOKIE_NAME, adminAuthConfigured, clientIp, verifyAdminKey } from "@/lib/auth";
import { recordAudit } from "@/lib/store";

/**
 * POST /api/auth/login - the browser dashboard's sign-in.
 *
 * Every admin API route already accepts the key as a cookie
 * (`lib/auth.ts#authenticateAdmin`); nothing ever set it, so a browser fetch
 * had no way to be authenticated even after typing the key once, and every
 * write action (queuing a command, uploading firmware, acknowledging an
 * alert) failed with "Admin authentication required". This is that missing
 * step: verify the key, then hand the browser a cookie carrying it.
 *
 * There is no session store - the cookie *is* the credential, exactly as
 * `X-Admin-Key` is for a script. httpOnly keeps it out of reach of any script
 * running on the page; it is still a shared secret, not a per-user login, so
 * treat it the same way you would the key itself.
 */
async function handlePOST(request: NextRequest): Promise<Response> {
  if (!adminAuthConfigured()) {
    // Nothing to sign in to - the API is already open. Say so rather than
    // accepting any value, which would look like it did something.
    return fail(409, "HEATER_ADMIN_KEY is not set; the admin API is unauthenticated");
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  try {
    const key = requiredString(parsed.body, "key", 200);
    if (!verifyAdminKey(key)) return fail(401, "Incorrect admin key");

    const jar = await cookies();
    jar.set(ADMIN_COOKIE_NAME, key, {
      httpOnly: true,
      // Whether *this connection* is HTTPS, not whether the server merely
      // runs in production mode. A `Secure` cookie set over plain HTTP is
      // silently dropped by the browser - it never reaches the jar, so
      // every sign-in looks like it worked (200 from this route) and then
      // bounces straight back to /login. Most deployments of this app sit
      // behind a plain-HTTP reverse proxy on a LAN, so that distinction
      // matters here more than it would for a public site.
      secure: isSecureRequest(request),
      sameSite: "lax",
      path: "/",
      // A shared operator key is meant to stay signed in; 30 days rather than
      // a session cookie so the dashboard survives a browser restart.
      maxAge: 60 * 60 * 24 * 30,
    });

    await recordAudit({ action: "admin.signed_in", detail: null, ip: clientIp(request) });

    return ok({ authenticated: true });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

/** True when the browser reached this route over HTTPS, directly or via a proxy. */
function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  return request.nextUrl.protocol === "https:";
}

export const POST = withApiLog("/api/auth/login", handlePOST);
