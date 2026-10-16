import { cookies } from "next/headers";
import { ok } from "@/lib/api";
import { withApiLog } from "@/lib/api-log";
import { ADMIN_COOKIE_NAME } from "@/lib/auth";

/** POST /api/auth/logout - clears the admin cookie set by /api/auth/login. */
async function handlePOST(): Promise<Response> {
  const jar = await cookies();
  jar.delete(ADMIN_COOKIE_NAME);
  return ok({ authenticated: false });
}

export const POST = withApiLog("/api/auth/logout", handlePOST);
