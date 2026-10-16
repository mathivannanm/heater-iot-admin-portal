import type { NextRequest } from "next/server";
import { authFailure, fail, ok } from "@/lib/api";
import { authenticateApp } from "@/lib/auth";
import { describeCurrentFor, getCurrentFirmware, listFirmwareReleases } from "@/lib/firmware";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/firmware/current?model=HEATER%20Ver1[&version=1.0.0]
 *
 * The mobile app's update check. Model-scoped rather than device-scoped, so
 * the app can ask before it has paired with anything, or on behalf of a board
 * it reaches only over Bluetooth. Pass the version the board reports as
 * `version` and the response says whether it differs from the current release.
 *
 * Also lists every *published* version of the model, newest first, so an app
 * that needs to offer a specific version (or step through them) can. Drafts
 * are never exposed here.
 */
async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateApp(request);
  if (!auth.ok) return authFailure(auth);

  const params = request.nextUrl.searchParams;
  const model = (params.get("model") ?? "HEATER Ver1").trim();
  if (!model || model.length > 64) return fail(422, '"model" must be 1-64 characters');
  const reported = params.get("version")?.trim() || null;

  const [current, releases] = await Promise.all([
    getCurrentFirmware(model),
    listFirmwareReleases(model),
  ]);

  const published = releases
    .filter((release) => release.publishedAt !== null)
    .map((release) => ({
      version: release.version,
      status: release.status,
      sizeBytes: release.sizeBytes,
      sha256: release.sha256,
      notes: release.notes,
      publishedAt: release.publishedAt,
      downloadPath: `/api/firmware/current/download?model=${encodeURIComponent(model)}&version=${encodeURIComponent(release.version)}`,
    }));

  return ok({
    ...describeCurrentFor(model, current, reported, request.nextUrl.origin),
    published,
    t: Date.now(),
  });
}

export const GET = withApiLog("/api/firmware/current", handleGET);
