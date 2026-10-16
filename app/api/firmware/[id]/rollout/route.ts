import type { NextRequest } from "next/server";
import { ValidationError, authFailure, fail, ok, optionalString, readJson } from "@/lib/api";
import { authenticateAdmin, clientIp } from "@/lib/auth";
import { FirmwareError, rolloutFirmware } from "@/lib/firmware";
import { recordAudit } from "@/lib/store";
import { withApiLog } from "@/lib/api-log";

/**
 * POST /api/firmware/:id/rollout
 *
 * Queues `FIRMWARE_UPDATE <version>` for every device of the release's model
 * not already reporting that version. Body is optional:
 * `{ "deviceIds": ["…"], "issuedBy": "<user uuid>" }` restricts the roll-out
 * to a subset. Returns what was queued and what was skipped, and why.
 */
async function handlePOST(
  request: NextRequest,
  ctx: RouteContext<"/api/firmware/[id]/rollout">,
): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const { id } = await ctx.params;

  let deviceIds: string[] | undefined;
  let issuedBy: string | null = null;
  if ((request.headers.get("content-length") ?? "0") !== "0") {
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    try {
      const raw = parsed.body.deviceIds;
      if (raw !== undefined) {
        if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
          throw new ValidationError('"deviceIds" must be an array of strings');
        }
        deviceIds = raw as string[];
      }
      issuedBy = optionalString(parsed.body, "issuedBy", 64) ?? null;
    } catch (error) {
      if (error instanceof ValidationError) return fail(422, error.message);
      throw error;
    }
  }

  try {
    const result = await rolloutFirmware(id, { deviceIds, issuedBy });

    await recordAudit({
      action: "firmware.rollout",
      detail: {
        releaseId: result.release.id,
        model: result.release.model,
        version: result.release.version,
        queued: result.queued.length,
        alreadyCurrent: result.alreadyCurrent,
        restricted: deviceIds !== undefined,
        actor: auth.actor,
      },
      ip: clientIp(request),
    });

    // 202: commands exist, nothing has reached hardware yet.
    return ok(result, { status: 202 });
  } catch (error) {
    if (error instanceof FirmwareError) return fail(error.status, error.message);
    throw error;
  }
}

export const POST = withApiLog("/api/firmware/[id]/rollout", handlePOST);
