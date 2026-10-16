import type { NextRequest } from "next/server";
import {
  ValidationError,
  authFailure,
  fail,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalObjectArray,
  optionalString,
  readJson,
  requiredInteger,
} from "@/lib/api";
import { authenticateAdmin, authenticateDevice } from "@/lib/auth";
import { isSensorDevice } from "@/lib/sensors";
import { claimPendingCommands, ingestTelemetry, type ChannelInput, type TelemetryInput } from "@/lib/store";
import { FAULT_CODES, HEAT_LEVELS, WIFI_MODES } from "@/lib/types";
import { config } from "@/lib/config";
import { withApiLog } from "@/lib/api-log";

/**
 * POST /api/devices/:id/telemetry
 *
 * The ingest endpoint. The HEATER Ver1 board posts one frame per cycle over
 * Wi-Fi, or the mobile app relays it when the board is reachable only over
 * Bluetooth. Every field is optional so a constrained device can send a partial
 * frame, and anything malformed is rejected with 422 naming the offending field
 * rather than silently coerced - bad firmware must not be able to write
 * nonsense into the history that operators later reason from. The exception is
 * an out-of-range temperature or humidity reading, which is a sensor fault
 * rather than a firmware bug: it is stored as null and reported in
 * `ignoredFields`.
 *
 * The response carries any queued commands, so a device needs a single round
 * trip per cycle rather than a separate poll.
 */
async function handlePOST(
  request: NextRequest,
  ctx: RouteContext<"/api/devices/[id]/telemetry">,
): Promise<Response> {
  const { id } = await ctx.params;

  const auth = await authenticateIngest(request, id);
  if (!auth.ok) return authFailure(auth);

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const input: TelemetryInput = {};

    // --- heat control -------------------------------------------------------
    const level = optionalEnum(body, "level", HEAT_LEVELS);
    if (level) input.level = level;
    assign(input, "levelValue", optionalNumber(body, "levelValue", { min: 0, max: 3 }));
    const mode = optionalString(body, "mode", 32);
    if (mode) input.mode = mode;
    assign(input, "manual", optionalBoolean(body, "manual"));
    assign(input, "autoFan", optionalBoolean(body, "autoFan"));
    assign(input, "tripped", optionalBoolean(body, "tripped"));

    // --- climate ------------------------------------------------------------
    assign(input, "climate", optionalBoolean(body, "climate"));
    // The range is what the firmware itself accepts ("settemp <10-60>"), not
    // the narrower 10-35 an operator may set from the portal: a board that was
    // given a higher target over Bluetooth must still be able to report in.
    if ("climateTargetC" in body) {
      input.climateTargetC = optionalNumber(body, "climateTargetC", { min: 10, max: 60 }) ?? null;
    }

    // --- electrical ---------------------------------------------------------
    assign(input, "totalCurrentA", optionalNumber(body, "totalCurrentA", { min: 0, max: 200 }));
    assign(input, "sumCurrentA", optionalNumber(body, "sumCurrentA", { min: 0, max: 200 }));
    assign(input, "totalPowerW", optionalNumber(body, "totalPowerW", { min: 0, max: 100_000 }));
    const readingSource = optionalString(body, "readingSource", 32);
    if (readingSource) input.readingSource = readingSource;
    assign(input, "meterVoltageV", optionalNumber(body, "meterVoltageV", { min: 0, max: 500 }));
    assign(input, "mainsVoltageV", optionalNumber(body, "mainsVoltageV", { min: 0, max: 500 }));

    // --- temperature and humidity -------------------------------------------
    // Bounds are the sensors' physical range, not a guess at room conditions:
    // a probe bolted to a heating element legitimately reads far above ambient.
    // A reading outside that range is a failed or disconnected sensor, so it is
    // stored as "no reading" instead of rejecting the frame: one faulty probe
    // must not stop the rest of the telemetry or knock the board offline.
    // The original value is still in `raw`.
    const ignoredFields: string[] = [];
    for (const key of [
      "temp1C",
      "temp2C",
      "temp3C",
      "temp4C",
      "dhtTempC",
      "dht2TempC",
      "avgTempC",
      "maxTempC",
    ] as const) {
      if (key in body) input[key] = sensorReading(body, key, -55, 300, ignoredFields);
    }
    for (const key of ["humidity1Pct", "humidity2Pct", "humidity3Pct"] as const) {
      if (key in body) input[key] = sensorReading(body, key, 0, 100, ignoredFields);
    }

    // --- sensor board -------------------------------------------------------
    // The TEMP-HUM Ver1 board says how many of its sensors are reading and
    // stamps every frame with its type. A heater sends neither.
    if ("sensorsOk" in body) {
      input.sensorsOk = optionalNumber(body, "sensorsOk", { min: 0, max: 32 }) ?? null;
    }
    // --- identity -------------------------------------------------------------
    // The board's own name (PORTAL_NAME + "_" + chip id in the HEATER Ver1
    // firmware). The device takes it only while nobody renamed it on the portal.
    const deviceName = optionalString(body, "deviceName", 80)?.trim();
    if (deviceName) input.deviceName = deviceName;
    if ("deviceType" in body) {
      input.deviceType = optionalString(body, "deviceType", 32)?.trim().toLowerCase() || null;
    }

    // --- protection limits in force -----------------------------------------
    for (const key of ["currentLimitA", "totalLimitA"] as const) {
      if (key in body) input[key] = optionalNumber(body, key, { min: 0, max: 200 }) ?? null;
    }
    if ("temperatureLimitC" in body) {
      input.temperatureLimitC = optionalNumber(body, "temperatureLimitC", { min: 0, max: 300 }) ?? null;
    }

    // --- connectivity -------------------------------------------------------
    const wifi = optionalEnum(body, "wifi", WIFI_MODES);
    if (wifi) input.wifi = wifi;
    if ("ip" in body) input.ip = optionalString(body, "ip", 45) ?? null;
    assign(input, "bluetoothClient", optionalBoolean(body, "bluetoothClient"));
    assign(input, "apiKeySet", optionalBoolean(body, "apiKeySet"));
    assign(input, "uptimeSeconds", optionalNumber(body, "uptimeSeconds", { min: 0 }));

    // Signal strength. Bounds are the physical range of a radio's RSSI report,
    // so a byte-order bug or a stuck sensor is rejected rather than skewing
    // the signal history. Firmware that cannot measure RSSI simply omits these
    // and the dashboard shows "no reading" instead of inventing a bar.
    // The API's own column name, so a frame recorded here and one recorded by
    // the HeaterFan API are the same row shape.
    if ("rssiDbm" in body) {
      input.rssiDbm = optionalNumber(body, "rssiDbm", { min: -120, max: 0 }) ?? null;
    } else if ("wifiRssiDbm" in body) {
      // The key the firmware integration guide and its reference sketch send.
      input.rssiDbm = optionalNumber(body, "wifiRssiDbm", { min: -120, max: 0 }) ?? null;
    } else if ("rssi" in body) {
      // The firmware's own short key, as documented for buildJson().
      input.rssiDbm = optionalNumber(body, "rssi", { min: -120, max: 0 }) ?? null;
    }
    if ("bleRssiDbm" in body) {
      input.bleRssiDbm = optionalNumber(body, "bleRssiDbm", { min: -120, max: 0 }) ?? null;
    }

    // --- per-channel readings -----------------------------------------------
    const rawChannels = optionalObjectArray(body, "channels", 6);
    if (rawChannels) {
      const channels: ChannelInput[] = [];
      const seen = new Set<number>();

      for (const entry of rawChannels) {
        const channelIndex = requiredInteger(entry, "channelIndex", { min: 0, max: 5 });
        if (seen.has(channelIndex)) {
          throw new ValidationError(`duplicate channelIndex ${channelIndex}`);
        }
        seen.add(channelIndex);

        const channel: ChannelInput = { channelIndex };
        const channelId = optionalString(entry, "channelId", 32);
        if (channelId) channel.channelId = channelId;
        assign(channel, "isOn", optionalBoolean(entry, "isOn"));
        assign(channel, "currentA", optionalNumber(entry, "currentA", { min: 0, max: 200 }));
        assign(channel, "powerW", optionalNumber(entry, "powerW", { min: 0, max: 50_000 }));
        assign(channel, "energyWh", optionalNumber(entry, "energyWh", { min: 0 }));
        const fault = optionalEnum(entry, "fault", FAULT_CODES);
        if (fault) channel.fault = fault;

        channels.push(channel);
      }
      input.channels = channels;
    }

    // The untouched payload is kept for forensics: when a reading looks wrong,
    // the question is always whether the device sent it or we mangled it.
    input.raw = body;

    const device = await ingestTelemetry(id, input);
    if (!device) return fail(404, "Device not found");

    return ok({
      accepted: true,
      receivedAt: Date.now(),
      nextIntervalMs: config.telemetryIntervalMs,
      // Sensor fields stored as null because the value was out of range, so
      // firmware and bench testers can see a probe is failing.
      ignoredFields,
      commands: await claimPendingCommands(id),
    });
  } catch (error) {
    if (error instanceof ValidationError) return fail(422, error.message);
    throw error;
  }
}

/**
 * A frame is normally authenticated by the device's own key, and for a heater
 * that is the only way in. The portal's sensor test tools run in a browser,
 * which never holds a device key (only its hash is stored), so for a sensor
 * board the admin credential is accepted as well - but only when the request
 * carries no device key at all, so a board presenting a wrong key is still
 * refused exactly as before.
 */
async function authenticateIngest(
  request: NextRequest,
  deviceId: string,
): Promise<Awaited<ReturnType<typeof authenticateDevice>>> {
  const device = await authenticateDevice(request, deviceId);
  if (device.ok || request.headers.has("x-device-key")) return device;

  if (authenticateAdmin(request).ok && (await isSensorDevice(deviceId))) {
    return { ok: true, deviceId };
  }
  return device;
}

/**
 * Parses a temperature or humidity reading. A value of the wrong type is still
 * a firmware bug and throws; a number outside the sensor's range (including a
 * read-failure sentinel) becomes null and its key is recorded in `ignored`.
 */
function sensorReading(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  ignored: string[],
): number | null {
  const value = optionalNumber(body, key) ?? null;
  if (value !== null && (value < min || value > max)) {
    ignored.push(key);
    return null;
  }
  return value;
}

/**
 * Copies a parsed field onto the input only when the device actually sent it.
 * `undefined` means "absent, leave the column default alone"; an explicit null
 * is a different thing and is handled at each call site that allows it.
 */
function assign<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null | undefined,
): void {
  if (value === undefined || value === null) return;
  target[key] = value;
}

export const POST = withApiLog("/api/devices/[id]/telemetry", handlePOST);
