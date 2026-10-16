import type { NextRequest } from "next/server";
import { authFailure, fail } from "@/lib/api";
import { authenticateApp } from "@/lib/auth";
import { getCurrentFirmware, getFirmwareImage, getPublishedFirmware, imageResponse } from "@/lib/firmware";
import { withApiLog } from "@/lib/api-log";

/**
 * GET  /api/firmware/current/download?model=HEATER%20Ver1[&version=1.2.0]
 * HEAD /api/firmware/current/download?...   - headers only (size, sha, version)
 *
 * The image for the mobile app to relay to a board. Without `version` it is
 * the current release; with it, that exact *published* version. Supports
 * `Range` for chunked transfer and `If-None-Match: "<sha256>"` for a 304.
 */
async function resolve(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const model = (params.get("model") ?? "HEATER Ver1").trim();
  if (!model || model.length > 64) return fail(422, '"model" must be 1-64 characters');
  const wanted = params.get("version")?.trim() || null;

  const release = wanted
    ? await getPublishedFirmware(model, wanted)
    : await getCurrentFirmware(model);
  if (!release) {
    return fail(404, wanted ? `No published release ${wanted} for ${model}` : `No current release for ${model}`);
  }
  const found = await getFirmwareImage(release.id);
  if (!found) return fail(404, "Release not found");
  return found;
}

async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateApp(request);
  if (!auth.ok) return authFailure(auth);

  const found = await resolve(request);
  if (found instanceof Response) return found;
  return imageResponse(found.image, found.release, request);
}

async function handleHEAD(request: NextRequest): Promise<Response> {
  const auth = authenticateApp(request);
  if (!auth.ok) return authFailure(auth);

  const found = await resolve(request);
  if (found instanceof Response) return new Response(null, { status: found.status, headers: found.headers });
  const full = imageResponse(found.image, found.release);
  return new Response(null, { status: 200, headers: full.headers });
}

export const GET = withApiLog("/api/firmware/current/download", handleGET);
export const HEAD = withApiLog("/api/firmware/current/download", handleHEAD);
