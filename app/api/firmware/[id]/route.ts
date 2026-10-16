import type { NextRequest } from "next/server";
import { ValidationError, authFailure, fail, ok, optionalBoolean, optionalEnum, optionalString, readJson } from "@/lib/api";
import { authenticateAdmin, clientIp } from "@/lib/auth";
import {
  FirmwareError,
  deleteFirmware,
  getFirmwareRelease,
  publishFirmware,
  setCurrentFirmware,
  unpublishFirmware,
  updateFirmwareNotes,
} from "@/lib/firmware";
import { recordAudit } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * GET    /api/firmware/:id - one release's metadata.
 * PATCH  /api/firmware/:id - move it through its lifecycle, or edit notes.
 * DELETE /api/firmware/:id - remove a draft or superseded release.
 *
 * PATCH body: `{ "action": "publish" | "set_current" | "unpublish",
 *                "makeCurrent"?: boolean, "notes"?: string | null }`.
 * `action` and `notes` may be combined; either alone is fine.
 */
const ACTIONS = ["publish", "set_current", "unpublish"] as const;

async function handleGET(
  request: NextRequest,
  ctx: RouteContext<"/api/firmware/[id]">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const release = await getFirmwareRelease(id);
  if (!release) return fail(404, "Release not found");
  return ok({ release });
}

async function handlePATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/firmware/[id]">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const action = optionalEnum(body, "action", ACTIONS) ?? null;
    const makeCurrent = optionalBoolean(body, "makeCurrent") ?? false;
    const hasNotes = "notes" in body;
    const notes = optionalString(body, "notes", 2000) ?? null;

    if (!action && !hasNotes) {
      return fail(422, 'Supply "action" (publish, set_current, unpublish) and/or "notes"');
    }

    let release = await getFirmwareRelease(id);
    if (!release) return fail(404, "Release not found");

    if (hasNotes) release = await updateFirmwareNotes(id, notes);

    if (action === "publish") release = await publishFirmware(id, { makeCurrent });
    else if (action === "set_current") release = await setCurrentFirmware(id);
    else if (action === "unpublish") release = await unpublishFirmware(id);

    if (action) {
      await recordAudit({
        action: `firmware.${action === "set_current" ? "current" : action}`,
        detail: {
          releaseId: release.id,
          model: release.model,
          version: release.version,
          makeCurrent,
          actor: auth.actor,
        },
        ip: clientIp(request),
      });
    }

    return ok({ release });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    if (error instanceof FirmwareError) return fail(error.status, error.message);
    throw error;
  }
}

async function handleDELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/firmware/[id]">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;
  try {
    const release = await deleteFirmware(id);
    await recordAudit({
      action: "firmware.deleted",
      detail: { releaseId: release.id, model: release.model, version: release.version, actor: auth.actor },
      ip: clientIp(request),
    });
    return ok({ removed: true, id });
  } catch (error) {
    if (error instanceof FirmwareError) return fail(error.status, error.message);
    throw error;
  }
}

export const GET = withApiLog("/api/firmware/[id]", handleGET);
export const PATCH = withApiLog("/api/firmware/[id]", handlePATCH);
export const DELETE = withApiLog("/api/firmware/[id]", handleDELETE);
