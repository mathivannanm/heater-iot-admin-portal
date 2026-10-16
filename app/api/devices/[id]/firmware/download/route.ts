import type { NextRequest } from "next/server";
import { authFailure, fail } from "@/lib/api";
import { authenticateAdmin, authenticateDevice } from "@/lib/auth";
import { getCurrentFirmware, getFirmwareImage, getPublishedFirmware, imageResponse } from "@/lib/firmware";
import { getDeviceView } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/devices/:id/firmware/download[?version=1.2.3]
 *
 * The image a device should flash: the current release for its model, or a
 * specific *published* version when asked (a roll-out names the version in its
 * command, so the board can fetch exactly what it was told to). Drafts are
 * never served. The body is the raw .bin; the SHA-256 travels in
 * `X-Firmware-Sha256` so the board can verify before it commits the partition.
 */
async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/firmware/download">,
): Promise<Response> {
  const { id } = await ctx.params;

  const deviceAuth = await authenticateDevice(request, id);
  if (!deviceAuth.ok) {
    const adminAuth = authenticateAdmin(request);
    if (!adminAuth.ok) return authFailure(deviceAuth);
  }

  const device = await getDeviceView(id);
  if (!device) return fail(404, "Device not found");

  const wanted = request.nextUrl.searchParams.get("version");
  const release = wanted
    ? await getPublishedFirmware(device.model, wanted)
    : await getCurrentFirmware(device.model);
  if (!release) {
    return fail(404, wanted ? `No published release ${wanted} for ${device.model}` : `No current release for ${device.model}`);
  }

  const found = await getFirmwareImage(release.id);
  if (!found) return fail(404, "Release not found");

  return imageResponse(found.image, found.release, request);
}

export const GET = withApiLog("/api/devices/[id]/firmware/download", handleGET);
