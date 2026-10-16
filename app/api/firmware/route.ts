import type { NextRequest } from "next/server";
import { authFailure, fail, ok } from "@/lib/api";
import { authenticateAdmin, clientIp } from "@/lib/auth";
import {
  FirmwareError,
  MAX_FIRMWARE_BYTES,
  createFirmwareRelease,
  listFirmwareReleases,
} from "@/lib/firmware";
import { recordAudit } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET  /api/firmware - every release, current first, without image bytes.
 * POST /api/firmware - upload a .bin as multipart/form-data.
 *
 * Fields: `file` (the image), `version` (1.2.3), optional `model`, `notes`,
 * and the flags `publish` / `makeCurrent` ("true" | "1" | "on"). Without a
 * flag the upload is a draft that devices cannot see.
 */
async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const model = request.nextUrl.searchParams.get("model") ?? undefined;
  return ok({ releases: await listFirmwareReleases(model) });
}

const TRUE_VALUES = new Set(["true", "1", "on", "yes"]);

function flag(form: FormData, key: string): boolean {
  const value = form.get(key);
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function field(form: FormData, key: string, maxLength: number): string | null {
  const value = form.get(key);
  if (value === null) return null;
  if (typeof value !== "string") throw new FirmwareError(`"${key}" must be a text field`);
  if (value.length > maxLength) throw new FirmwareError(`"${key}" exceeds ${maxLength} characters`);
  return value;
}

async function handlePOST(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return fail(400, "Upload firmware as multipart/form-data with a \"file\" field");
  }

  // A body larger than the cap is refused before it is buffered; the exact
  // size is re-checked after reading, because Content-Length is advisory.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_FIRMWARE_BYTES + 64 * 1024) {
    return fail(413, `The image exceeds ${MAX_FIRMWARE_BYTES / 1024 / 1024} MB`);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "Request body is not valid multipart/form-data");
  }

  try {
    const file = form.get("file");
    if (!(file instanceof File)) throw new FirmwareError('"file" is required', 400);

    const version = field(form, "version", 64);
    if (!version || version.trim() === "") throw new FirmwareError('"version" is required');

    const release = await createFirmwareRelease({
      version,
      model: field(form, "model", 64) ?? undefined,
      filename: file.name || "firmware.bin",
      notes: field(form, "notes", 2000),
      image: Buffer.from(await file.arrayBuffer()),
      publish: flag(form, "publish"),
      makeCurrent: flag(form, "makeCurrent"),
      uploadedBy: field(form, "userId", 64),
    });

    await recordAudit({
      action: release.isCurrent
        ? "firmware.published_current"
        : release.publishedAt
          ? "firmware.published"
          : "firmware.uploaded",
      detail: {
        releaseId: release.id,
        model: release.model,
        version: release.version,
        sha256: release.sha256,
        sizeBytes: release.sizeBytes,
        actor: auth.actor,
      },
      ip: clientIp(request),
    });

    return ok({ release }, { status: 201 });
  } catch (error) {
    if (error instanceof FirmwareError) return fail(error.status, error.message);
    throw error;
  }
}

export const GET = withApiLog("/api/firmware", handleGET);
export const POST = withApiLog("/api/firmware", handlePOST);
