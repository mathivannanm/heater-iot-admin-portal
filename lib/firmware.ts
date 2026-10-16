import { createHash } from "node:crypto";
import { ms, msRequired, query, queryOne, transaction } from "./db";
import { isUuid, issueCommand, listDeviceViews } from "./store";
import type { DeviceView, FirmwareRelease, FirmwareStatus } from "./types";

/**
 * Firmware releases.
 *
 * A release moves through three states. An upload creates a *draft*, which
 * only the portal can see. *Publishing* stamps `published_at` and makes the
 * image fetchable by devices. Marking a published release *current* makes it
 * the one release per model that the fleet is expected to run: it is what a
 * device is handed when it asks "is there an update for me?", and what a
 * roll-out sends the fleet to.
 *
 * Nothing here talks to hardware directly. A roll-out queues an ordinary
 * `FIRMWARE_UPDATE <version>` command; the board collects it on its next
 * round trip, downloads the image over its own authenticated route and
 * reports the new version in its next registration or telemetry frame. The
 * "devices on this version" count therefore comes from what the devices
 * themselves report, never from what was pushed.
 */

/** The command a roll-out queues. The version is the only argument the board needs. */
export const FIRMWARE_UPDATE_COMMAND = "FIRMWARE_UPDATE";

/** Upper bound on an uploaded image. Largest ESP32 app partition in common use is 4 MB. */
export const MAX_FIRMWARE_BYTES = 8 * 1024 * 1024;

/** `1.2.3`, optionally with a leading `v` and a `-rc1` / `+build` suffix. */
const VERSION_PATTERN = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

export class FirmwareError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 422,
  ) {
    super(message);
  }
}

interface ReleaseRow {
  id: string;
  model: string;
  version: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  notes: string | null;
  is_current: boolean;
  published_at: Date | null;
  uploaded_by: string | null;
  created_at: Date;
  updated_at: Date;
  device_count: number;
}

// Every read goes through this projection so the image bytes never ride along
// with a list: one page of releases must not pull tens of megabytes.
const RELEASE_COLUMNS = `
  r.id, r.model, r.version, r.filename, r.size_bytes, r.sha256, r.notes,
  r.is_current, r.published_at, r.uploaded_by, r.created_at, r.updated_at,
  (SELECT count(*) FROM devices d
    WHERE d.model = r.model AND d.firmware_version = r.version)::int AS device_count`;

function statusOf(row: Pick<ReleaseRow, "is_current" | "published_at">): FirmwareStatus {
  if (row.is_current) return "current";
  return row.published_at ? "published" : "draft";
}

function mapRelease(row: ReleaseRow): FirmwareRelease {
  return {
    id: row.id,
    model: row.model,
    version: row.version,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    notes: row.notes,
    status: statusOf(row),
    isCurrent: row.is_current,
    publishedAt: ms(row.published_at),
    uploadedBy: row.uploaded_by,
    createdAt: msRequired(row.created_at),
    updatedAt: msRequired(row.updated_at),
    deviceCount: row.device_count,
  };
}

export function isValidFirmwareVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

// ------------------------------------------------------------------- reads

export async function listFirmwareReleases(model?: string): Promise<FirmwareRelease[]> {
  const rows = await query<ReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM firmware_releases r
     ${model ? "WHERE r.model = $1" : ""}
     ORDER BY r.is_current DESC, r.created_at DESC`,
    model ? [model] : [],
  );
  return rows.map(mapRelease);
}

export async function getFirmwareRelease(id: string): Promise<FirmwareRelease | null> {
  if (!isUuid(id)) return null;
  const row = await queryOne<ReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM firmware_releases r WHERE r.id = $1`,
    [id],
  );
  return row ? mapRelease(row) : null;
}

/** The one current release for a model, or null when none has been marked. */
export async function getCurrentFirmware(model: string): Promise<FirmwareRelease | null> {
  const row = await queryOne<ReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM firmware_releases r WHERE r.model = $1 AND r.is_current`,
    [model],
  );
  return row ? mapRelease(row) : null;
}

/** A published release of a model by exact version string. */
export async function getPublishedFirmware(
  model: string,
  version: string,
): Promise<FirmwareRelease | null> {
  const row = await queryOne<ReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM firmware_releases r
     WHERE r.model = $1 AND r.version = $2 AND r.published_at IS NOT NULL`,
    [model, version],
  );
  return row ? mapRelease(row) : null;
}

export interface FirmwareImage {
  release: FirmwareRelease;
  image: Buffer;
}

/** The image bytes, fetched only when someone is actually downloading. */
export async function getFirmwareImage(id: string): Promise<FirmwareImage | null> {
  const release = await getFirmwareRelease(id);
  if (!release) return null;
  const row = await queryOne<{ image: Buffer }>(
    `SELECT image FROM firmware_releases WHERE id = $1`,
    [id],
  );
  if (!row) return null;
  return { release, image: row.image };
}

// ------------------------------------------------------------------ writes

export interface CreateFirmwareInput {
  version: string;
  model?: string;
  filename: string;
  notes?: string | null;
  image: Buffer;
  /** Publish straight away instead of leaving a draft. */
  publish?: boolean;
  /** Publish and mark current in one step. Implies `publish`. */
  makeCurrent?: boolean;
  uploadedBy?: string | null;
}

/** The `"fw":"x.y.z"` version string compiled into a HEATER image, if exactly one is present. */
export function embeddedFirmwareVersion(image: Buffer): string | null {
  const found = new Set<string>();
  const re = /"fw":"([0-9A-Za-z.+-]{1,32})"/g;
  const text = image.toString("latin1");
  for (let m = re.exec(text); m; m = re.exec(text)) found.add(m[1]);
  return found.size === 1 ? [...found][0] : null;
}

export async function createFirmwareRelease(input: CreateFirmwareInput): Promise<FirmwareRelease> {
  const version = input.version.trim();
  const model = (input.model ?? "HEATER Ver1").trim() || "HEATER Ver1";

  if (!isValidFirmwareVersion(version)) {
    throw new FirmwareError(
      `"version" must look like 1.2.3 (optionally v-prefixed, with a -rc1 or +build suffix)`,
    );
  }
  if (input.image.length === 0) throw new FirmwareError("The uploaded file is empty");
  if (input.image.length > MAX_FIRMWARE_BYTES) {
    throw new FirmwareError(`The image exceeds ${MAX_FIRMWARE_BYTES / 1024 / 1024} MB`);
  }

  // The board reports the FW_VERSION compiled into it, and the image carries
  // that string as `"fw":"1.8.1"`. A release labelled with any other version
  // never counts as installed, so the app offers it forever.
  const embedded = embeddedFirmwareVersion(input.image);
  if (embedded && embedded.replace(/^v/i, "") !== version.replace(/^v/i, "")) {
    throw new FirmwareError(
      `This file is firmware ${embedded} (FW_VERSION in the code), not ${version}. ` +
        `Upload it as ${embedded}, or set FW_VERSION to "${version}" and rebuild.`,
    );
  }

  const sha256 = createHash("sha256").update(input.image).digest("hex");
  const makeCurrent = input.makeCurrent === true;
  const publish = makeCurrent || input.publish === true;

  const id = await transaction(async (client) => {
    if (makeCurrent) {
      await client.query(
        `UPDATE firmware_releases SET is_current = false, updated_at = now()
         WHERE model = $1 AND is_current`,
        [model],
      );
    }
    let inserted;
    try {
      inserted = await client.query<{ id: string }>(
        `INSERT INTO firmware_releases
           (model, version, filename, size_bytes, sha256, notes, image, is_current, published_at, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() END, $10)
         RETURNING id`,
        [
          model,
          version,
          input.filename,
          input.image.length,
          sha256,
          input.notes?.trim() || null,
          input.image,
          makeCurrent,
          publish,
          input.uploadedBy && isUuid(input.uploadedBy) ? input.uploadedBy : null,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new FirmwareError(`Version ${version} already exists for ${model}`, 409);
      }
      throw error;
    }
    return inserted.rows[0].id;
  });

  return (await getFirmwareRelease(id))!;
}

/** Stamps `published_at`. Optionally marks the release current in the same transaction. */
export async function publishFirmware(
  id: string,
  options: { makeCurrent?: boolean } = {},
): Promise<FirmwareRelease> {
  const release = await getFirmwareRelease(id);
  if (!release) throw new FirmwareError("Release not found", 404);

  await transaction(async (client) => {
    await client.query(
      `UPDATE firmware_releases
       SET published_at = COALESCE(published_at, now()), updated_at = now()
       WHERE id = $1`,
      [id],
    );
    if (options.makeCurrent) {
      await client.query(
        `UPDATE firmware_releases SET is_current = false, updated_at = now()
         WHERE model = $1 AND is_current AND id <> $2`,
        [release.model, id],
      );
      await client.query(
        `UPDATE firmware_releases SET is_current = true, updated_at = now() WHERE id = $1`,
        [id],
      );
    }
  });

  return (await getFirmwareRelease(id))!;
}

/**
 * Makes a published release the current one for its model, demoting whichever
 * release held that flag. A draft is refused: devices must never be sent to
 * an image nobody chose to publish.
 */
export async function setCurrentFirmware(id: string): Promise<FirmwareRelease> {
  const release = await getFirmwareRelease(id);
  if (!release) throw new FirmwareError("Release not found", 404);
  if (!release.publishedAt) {
    throw new FirmwareError("Publish the release before making it current", 409);
  }
  if (release.isCurrent) return release;

  await transaction(async (client) => {
    await client.query(
      `UPDATE firmware_releases SET is_current = false, updated_at = now()
       WHERE model = $1 AND is_current`,
      [release.model],
    );
    await client.query(
      `UPDATE firmware_releases SET is_current = true, updated_at = now() WHERE id = $1`,
      [id],
    );
  });

  return (await getFirmwareRelease(id))!;
}

/**
 * Withdraws a release from devices. A current release must be replaced first;
 * silently leaving a model with no current version would make every device's
 * next update check answer "nothing", which is not what withdrawing means.
 */
export async function unpublishFirmware(id: string): Promise<FirmwareRelease> {
  const release = await getFirmwareRelease(id);
  if (!release) throw new FirmwareError("Release not found", 404);
  if (release.isCurrent) {
    throw new FirmwareError("Make another release current before withdrawing this one", 409);
  }
  await query(
    `UPDATE firmware_releases SET published_at = NULL, updated_at = now() WHERE id = $1`,
    [id],
  );
  return (await getFirmwareRelease(id))!;
}

export async function updateFirmwareNotes(id: string, notes: string | null): Promise<FirmwareRelease> {
  const release = await getFirmwareRelease(id);
  if (!release) throw new FirmwareError("Release not found", 404);
  await query(
    `UPDATE firmware_releases SET notes = $2, updated_at = now() WHERE id = $1`,
    [id, notes?.trim() || null],
  );
  return (await getFirmwareRelease(id))!;
}

export async function deleteFirmware(id: string): Promise<FirmwareRelease> {
  const release = await getFirmwareRelease(id);
  if (!release) throw new FirmwareError("Release not found", 404);
  if (release.isCurrent) {
    throw new FirmwareError("The current release cannot be deleted; make another current first", 409);
  }
  await query(`DELETE FROM firmware_releases WHERE id = $1`, [id]);
  return release;
}

// ----------------------------------------------------------------- roll-out

export interface RolloutResult {
  release: FirmwareRelease;
  command: string;
  /** Devices a command was queued for. */
  queued: Array<{ deviceId: string; name: string; commandId: string; online: boolean }>;
  /** Devices already reporting this version, left alone. */
  alreadyCurrent: number;
  /** Devices of another model, never targeted. */
  otherModel: number;
}

/**
 * Queues `FIRMWARE_UPDATE <version>` for every device of the release's model
 * that is not already reporting that version, or for an explicit subset.
 * Offline devices are included on purpose: a queued command waits for the
 * board to come back, which is exactly the behaviour an operator wants from
 * "update the fleet".
 */
export async function rolloutFirmware(
  id: string,
  options: { deviceIds?: string[]; issuedBy?: string | null } = {},
): Promise<RolloutResult> {
  const release = await getFirmwareRelease(id);
  if (!release) throw new FirmwareError("Release not found", 404);
  if (!release.publishedAt) throw new FirmwareError("Publish the release before rolling it out", 409);

  const wanted = options.deviceIds ? new Set(options.deviceIds) : null;
  const devices = await listDeviceViews();
  const command = `${FIRMWARE_UPDATE_COMMAND} ${release.version}`;

  const result: RolloutResult = {
    release,
    command,
    queued: [],
    alreadyCurrent: 0,
    otherModel: 0,
  };

  for (const device of devices) {
    if (wanted && !wanted.has(device.id)) continue;
    if (device.model !== release.model) {
      result.otherModel += 1;
      continue;
    }
    if (device.firmwareVersion === release.version) {
      result.alreadyCurrent += 1;
      continue;
    }
    const issued = await issueCommand(device.id, command, options.issuedBy ?? null);
    if (issued) {
      result.queued.push({
        deviceId: device.id,
        name: device.name,
        commandId: issued.id,
        online: device.online,
      });
    }
  }

  return result;
}

/** What one device should be told when it asks whether an update exists. */
export function describeUpdateFor(
  device: Pick<DeviceView, "id" | "model" | "firmwareVersion">,
  current: FirmwareRelease | null,
): {
  model: string;
  reportedVersion: string | null;
  updateAvailable: boolean;
  release: FirmwareRelease | null;
  downloadPath: string | null;
} {
  const updateAvailable = current !== null && current.version !== device.firmwareVersion;
  return {
    model: device.model,
    reportedVersion: device.firmwareVersion,
    updateAvailable,
    release: current,
    downloadPath: current ? `/api/devices/${device.id}/firmware/download` : null,
  };
}

// ----------------------------------------------------------------- download

/**
 * What the mobile app (or anything model-scoped rather than device-scoped) is
 * told about the current release. `reportedVersion` is whatever the caller
 * says the board is running; `updateAvailable` is a plain string comparison
 * against the current version, which is deliberate - "different" is the only
 * honest answer without a guaranteed ordering of version strings.
 */
export function describeCurrentFor(
  model: string,
  current: FirmwareRelease | null,
  reportedVersion: string | null,
  origin: string,
): {
  model: string;
  reportedVersion: string | null;
  updateAvailable: boolean;
  current: FirmwareRelease | null;
  downloadPath: string | null;
  downloadUrl: string | null;
} {
  const path = current
    ? `/api/firmware/current/download?model=${encodeURIComponent(model)}&version=${encodeURIComponent(current.version)}`
    : null;
  return {
    model,
    reportedVersion,
    updateAvailable: current !== null && reportedVersion !== current.version,
    current,
    downloadPath: path,
    downloadUrl: path ? new URL(path, origin).toString() : null,
  };
}

/**
 * The image as an HTTP response. Shared by the operator, device and mobile
 * downloads so all three carry the same verification headers.
 *
 * Honours `If-None-Match` against the SHA-256 (so a client that already has
 * the image gets a 304 instead of megabytes) and a single `Range` (so an app
 * relaying over Bluetooth can pull the image in chunks and resume).
 */
export function imageResponse(image: Buffer, release: FirmwareRelease, request?: Request): Response {
  const safeName = release.filename.replace(/[^\w.-]+/g, "_") || "firmware.bin";
  const etag = `"${release.sha256}"`;
  const common = {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${safeName}"`,
    "cache-control": "no-store",
    "accept-ranges": "bytes",
    etag,
    "x-firmware-model": release.model,
    "x-firmware-version": release.version,
    "x-firmware-sha256": release.sha256,
    "x-firmware-size": String(image.length),
  };

  if (request?.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: common });
  }

  const range = request ? parseRange(request.headers.get("range"), image.length) : null;
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...common, "content-range": `bytes */${image.length}` },
    });
  }
  if (range) {
    const chunk = image.subarray(range.start, range.end + 1);
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        ...common,
        "content-length": String(chunk.length),
        "content-range": `bytes ${range.start}-${range.end}/${image.length}`,
      },
    });
  }

  return new Response(new Uint8Array(image), {
    status: 200,
    headers: { ...common, "content-length": String(image.length) },
  });
}

/** `bytes=start-end`, `bytes=start-` or `bytes=-suffix`; one range only. */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";

  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) {
    return "invalid";
  }
  return { start, end };
}
