import type { NextRequest } from "next/server";
import { authFailure, fail } from "@/lib/api";
import { authenticateAdmin } from "@/lib/auth";
import { getFirmwareImage, imageResponse } from "@/lib/firmware";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/firmware/:id/download - the image bytes, for an operator.
 *
 * Devices do not use this route: they fetch through their own authenticated
 * `/api/devices/:id/firmware/download`, which resolves to the current release
 * for their model so a board never has to know a release id.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/firmware/[id]/download">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const found = await getFirmwareImage(id);
  if (!found) return fail(404, "Release not found");

  return imageResponse(found.image, found.release, request);
}

export const GET = withApiLog("/api/firmware/[id]/download", handleGET);
