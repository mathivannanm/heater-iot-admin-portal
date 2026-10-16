import type { NextRequest } from "next/server";
import { authFailure, ok } from "@/lib/api";
import { authenticateAdmin } from "@/lib/auth";
import { listRooms } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/** GET /api/rooms - rooms with their device counts, for the dashboard filters. */
async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);
  return ok({ rooms: await listRooms() });
}

export const GET = withApiLog("/api/rooms", handleGET);
