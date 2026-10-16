import { createHash, randomBytes } from "node:crypto";
import { config } from "./config";
import { ms, msRequired, num, numRequired, query, queryOne, text, transaction } from "./db";
import { EventBus } from "./events";
import { evaluateSensorAlerts } from "./sensors";
import { attentionScore, buildDeviceView, computeStats, deriveLiveness } from "./status";
import { SENSOR_DEVICE_TYPE, isSensorModel, type ClaimRequest } from "./types";
import type {
  AlertSeverity,
  AuditEntry,
  ChannelConfig,
  ChannelReading,
  CommandStatus,
  DeviceAlert,
  DeviceCommand,
  DeviceRecord,
  DeviceSettings,
  DeviceType,
  NameSource,
  DeviceView,
  EnergyBucket,
  FaultCode,
  FleetStats,
  HeatLevel,
  TelemetryFrame,
  WifiMode,
} from "./types";

/**
 * The device repository, backed by the `heaterfan` Postgres database.
 *
 * Every read and write the application performs goes through this module, so
 * the route handlers, the SSE stream and the pages never see SQL. Nothing is
 * cached in process memory: a value on the dashboard is a value that is in the
 * database, which is what makes the numbers survive a restart and stay correct
 * when a second server instance is added.
 */

// ---------------------------------------------------------------- raw db rows

interface DeviceRow {
  id: string;
  home_id: string;
  room_id: string | null;
  name: string;
  bluetooth_name: string;
  bluetooth_address: string | null;
  serial_number: string | null;
  firmware_version: string | null;
  model: string;
  device_type: string;
  name_source: string;
  home_ssid: string | null;
  local_address: string | null;
  remote_address: string | null;
  device_key_hash: string | null;
  device_key_set_at: Date | null;
  last_seen_at: Date | null;
  latest_telemetry_id: number | null;
  created_at: Date;
  updated_at: Date;
  room_name: string | null;
  room_icon: string | null;
  home_name: string;
  home_timezone: string;
}

interface TelemetryRow {
  id: number;
  device_id: string;
  recorded_at: Date;
  level: HeatLevel;
  level_value: number;
  mode: string;
  manual: boolean;
  auto_fan: boolean;
  tripped: boolean;
  climate: boolean;
  climate_target_c: number | null;
  total_current_a: number;
  sum_current_a: number;
  total_power_w: number;
  reading_source: string;
  meter_voltage_v: number;
  mains_voltage_v: number;
  temp_1_c: number | null;
  temp_2_c: number | null;
  temp_3_c: number | null;
  temp_4_c: number | null;
  dht_temp_c: number | null;
  dht_2_temp_c: number | null;
  avg_temp_c: number | null;
  max_temp_c: number | null;
  humidity_1_pct: number | null;
  humidity_2_pct: number | null;
  humidity_3_pct: number | null;
  sensors_ok: number | null;
  device_type: string | null;
  current_limit_a: number | null;
  total_limit_a: number | null;
  temperature_limit_c: number | null;
  wifi: WifiMode;
  ip: string | null;
  bluetooth_client: boolean;
  api_key_set: boolean;
  uptime_seconds: number;
  wifi_rssi_dbm: number | null;
  ble_rssi_dbm: number | null;
  raw: Record<string, unknown> | null;
}

interface TelemetryChannelRow {
  telemetry_id: number;
  device_id: string;
  recorded_at: Date;
  channel_index: number;
  channel_id: string;
  is_on: boolean;
  current_a: number;
  power_w: number;
  energy_wh: number;
  fault: FaultCode;
}

// ------------------------------------------------------------------- mappers

/**
 * A board is a sensor when its model says so or a frame has ever said so. The
 * model is checked as well as the column so a sensor added on the portal, or
 * claimed by serial, is recognised before its first frame arrives.
 */
function deviceTypeOf(row: Pick<DeviceRow, "device_type" | "model">): DeviceType {
  return row.device_type === SENSOR_DEVICE_TYPE || isSensorModel(row.model) ? "temphum" : "heater";
}

function mapDevice(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    homeId: row.home_id,
    roomId: row.room_id,
    name: row.name,
    bluetoothName: row.bluetooth_name,
    bluetoothAddress: text(row.bluetooth_address),
    serialNumber: text(row.serial_number),
    firmwareVersion: text(row.firmware_version),
    model: row.model,
    deviceType: deviceTypeOf(row),
    nameSource: row.name_source === "portal" ? "portal" : "device",
    homeSsid: text(row.home_ssid),
    localAddress: text(row.local_address),
    remoteAddress: text(row.remote_address),
    deviceKeySetAt: ms(row.device_key_set_at),
    lastSeenAt: ms(row.last_seen_at),
    latestTelemetryId: row.latest_telemetry_id,
    createdAt: msRequired(row.created_at),
    updatedAt: msRequired(row.updated_at),
    roomName: row.room_name,
    roomIcon: row.room_icon,
    homeName: row.home_name,
    homeTimezone: row.home_timezone,
  };
}

function mapChannelReading(row: TelemetryChannelRow): ChannelReading {
  return {
    channelIndex: row.channel_index,
    channelId: row.channel_id,
    isOn: row.is_on,
    currentA: numRequired(row.current_a),
    powerW: numRequired(row.power_w),
    energyWh: numRequired(row.energy_wh),
    fault: row.fault,
  };
}

function mapTelemetry(row: TelemetryRow, channels: ChannelReading[]): TelemetryFrame {
  return {
    id: row.id,
    deviceId: row.device_id,
    recordedAt: msRequired(row.recorded_at),
    level: row.level,
    levelValue: row.level_value,
    mode: row.mode,
    manual: row.manual,
    autoFan: row.auto_fan,
    tripped: row.tripped,
    climate: row.climate,
    climateTargetC: num(row.climate_target_c),
    totalCurrentA: numRequired(row.total_current_a),
    sumCurrentA: numRequired(row.sum_current_a),
    totalPowerW: numRequired(row.total_power_w),
    readingSource: row.reading_source,
    meterVoltageV: numRequired(row.meter_voltage_v),
    mainsVoltageV: numRequired(row.mains_voltage_v),
    temp1C: num(row.temp_1_c),
    temp2C: num(row.temp_2_c),
    temp3C: num(row.temp_3_c),
    temp4C: num(row.temp_4_c),
    dhtTempC: num(row.dht_temp_c),
    dht2TempC: num(row.dht_2_temp_c),
    avgTempC: num(row.avg_temp_c),
    maxTempC: num(row.max_temp_c),
    humidity1Pct: num(row.humidity_1_pct),
    humidity2Pct: num(row.humidity_2_pct),
    humidity3Pct: num(row.humidity_3_pct),
    sensorsOk: row.sensors_ok ?? null,
    deviceType: text(row.device_type),
    currentLimitA: num(row.current_limit_a),
    totalLimitA: num(row.total_limit_a),
    temperatureLimitC: num(row.temperature_limit_c),
    wifi: row.wifi,
    ip: text(row.ip),
    bluetoothClient: row.bluetooth_client,
    apiKeySet: row.api_key_set,
    uptimeSeconds: row.uptime_seconds,
    rssiDbm: num(row.wifi_rssi_dbm),
    bleRssiDbm: num(row.ble_rssi_dbm),
    raw: row.raw,
    channels: channels.sort((a, b) => a.channelIndex - b.channelIndex),
  };
}

const DEVICE_SELECT = `
  SELECT d.*, r.name AS room_name, r.icon AS room_icon,
         h.name AS home_name, h.timezone AS home_timezone
  FROM devices d
  LEFT JOIN rooms r ON r.id = d.room_id
  JOIN homes h ON h.id = d.home_id
`;

// ------------------------------------------------------------------ event bus

declare global {
  var __heaterBus: EventBus | undefined;
}

export function getBus(): EventBus {
  if (!globalThis.__heaterBus) globalThis.__heaterBus = new EventBus();
  return globalThis.__heaterBus;
}

// -------------------------------------------------------------- device reads

/**
 * Loads every device with its newest telemetry frame, channel configuration,
 * settings and open-alert summary.
 *
 * This is four queries regardless of fleet size, rather than N+1 per device:
 * `DISTINCT ON` rides the (device_id, recorded_at DESC) index to pick each
 * device's latest frame in a single pass.
 */
export async function listDeviceViews(now: number = Date.now()): Promise<DeviceView[]> {
  const deviceRows = await query<DeviceRow>(`${DEVICE_SELECT} ORDER BY d.name`);
  if (deviceRows.length === 0) return [];

  const ids = deviceRows.map((row) => row.id);

  const [telemetryRows, channelRows, settingsRows, alertRows] = await Promise.all([
    query<TelemetryRow>(
      `SELECT DISTINCT ON (device_id) *
       FROM telemetry
       WHERE device_id = ANY($1)
       ORDER BY device_id, recorded_at DESC`,
      [ids],
    ),
    query<{
      device_id: string;
      channel_index: number;
      channel_id: string;
      name: string;
      kind: ChannelConfig["kind"];
      relay_pin: number | null;
      ct_pin: number | null;
      calibration: number;
      enabled: boolean;
    }>(
      `SELECT device_id, channel_index, channel_id, name, kind, relay_pin, ct_pin, calibration, enabled
       FROM device_channels WHERE device_id = ANY($1)
       ORDER BY device_id, channel_index`,
      [ids],
    ),
    query<{
      device_id: string;
      current_limit_a: number;
      total_limit_a: number;
      temperature_limit_c: number;
      mains_voltage_v: number;
      auto_fan: boolean;
      climate_enabled: boolean;
      climate_target_c: number;
      ir_slots: unknown[];
      updated_at: Date;
    }>(`SELECT * FROM device_settings WHERE device_id = ANY($1)`, [ids]),
    query<{ device_id: string; open_count: number; worst: number }>(
      `SELECT device_id, count(*)::int AS open_count,
              max(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)::int AS worst
       FROM alerts WHERE device_id = ANY($1) AND cleared_at IS NULL
       GROUP BY device_id`,
      [ids],
    ),
  ]);

  const frameIds = telemetryRows.map((row) => row.id);
  const readingRows = frameIds.length
    ? await query<TelemetryChannelRow>(
        `SELECT * FROM telemetry_channels WHERE telemetry_id = ANY($1)`,
        [frameIds],
      )
    : [];

  const readingsByFrame = new Map<number, ChannelReading[]>();
  for (const row of readingRows) {
    const list = readingsByFrame.get(row.telemetry_id) ?? [];
    list.push(mapChannelReading(row));
    readingsByFrame.set(row.telemetry_id, list);
  }

  const frameByDevice = new Map<string, TelemetryFrame>();
  for (const row of telemetryRows) {
    frameByDevice.set(row.device_id, mapTelemetry(row, readingsByFrame.get(row.id) ?? []));
  }

  const channelsByDevice = new Map<string, ChannelConfig[]>();
  for (const row of channelRows) {
    const list = channelsByDevice.get(row.device_id) ?? [];
    list.push({
      channelIndex: row.channel_index,
      channelId: row.channel_id,
      name: row.name,
      kind: row.kind,
      relayPin: row.relay_pin,
      ctPin: row.ct_pin,
      calibration: numRequired(row.calibration, 1),
      enabled: row.enabled,
    });
    channelsByDevice.set(row.device_id, list);
  }

  const settingsByDevice = new Map<string, DeviceSettings>();
  for (const row of settingsRows) {
    settingsByDevice.set(row.device_id, {
      deviceId: row.device_id,
      currentLimitA: numRequired(row.current_limit_a, config.defaults.currentLimitA),
      totalLimitA: numRequired(row.total_limit_a, config.defaults.totalLimitA),
      temperatureLimitC: numRequired(row.temperature_limit_c, config.defaults.temperatureLimitC),
      mainsVoltageV: numRequired(row.mains_voltage_v, config.defaults.mainsVoltageV),
      autoFan: row.auto_fan,
      climateEnabled: row.climate_enabled,
      climateTargetC: numRequired(row.climate_target_c, config.defaults.climateTargetC),
      irSlots: Array.isArray(row.ir_slots) ? row.ir_slots : [],
      updatedAt: msRequired(row.updated_at),
    });
  }

  const severityFromRank = (rank: number): AlertSeverity =>
    rank >= 3 ? "critical" : rank === 2 ? "warning" : "info";

  const alertsByDevice = new Map<string, { count: number; worst: AlertSeverity }>();
  for (const row of alertRows) {
    alertsByDevice.set(row.device_id, {
      count: row.open_count,
      worst: severityFromRank(row.worst),
    });
  }

  return deviceRows.map((row) => {
    const alerts = alertsByDevice.get(row.id);
    return buildDeviceView(
      {
        record: mapDevice(row),
        telemetry: frameByDevice.get(row.id) ?? null,
        channels: channelsByDevice.get(row.id) ?? [],
        settings: settingsByDevice.get(row.id) ?? null,
        openAlertCount: alerts?.count ?? 0,
        worstAlertSeverity: alerts?.worst ?? null,
      },
      now,
    );
  });
}

export async function getDeviceView(
  deviceId: string,
  now: number = Date.now(),
): Promise<DeviceView | null> {
  if (!isUuid(deviceId)) return null;
  const views = await listDeviceViews(now);
  return views.find((view) => view.id === deviceId) ?? null;
}

/**
 * The heater fleet: every device that is not a sensor board. The device
 * table, the fleet counters and the live stream are all built from this, so a
 * TEMP-HUM board never shows up as a heater with six idle relays.
 */
export async function listHeaterViews(now: number = Date.now()): Promise<DeviceView[]> {
  const views = await listDeviceViews(now);
  return views.filter((view) => view.deviceType === "heater");
}

export async function getDeviceRecord(deviceId: string): Promise<DeviceRecord | null> {
  if (!isUuid(deviceId)) return null;
  const row = await queryOne<DeviceRow>(`${DEVICE_SELECT} WHERE d.id = $1`, [deviceId]);
  return row ? mapDevice(row) : null;
}

/** Guards every id-taking query: Postgres throws 22P02 on a malformed uuid. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ------------------------------------------------------------ list / filter

export interface ListOptions {
  search?: string;
  status?: "all" | "online" | "offline" | "heating" | "fault" | "tripped";
  connection?: "all" | "sta" | "ap" | "bluetooth";
  room?: string;
  kind?: "all" | "heater" | "fan" | "light";
  sortBy?: "name" | "status" | "lastSeen" | "temperature" | "power" | "room" | "alerts";
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ListResult {
  devices: DeviceView[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Search, filter, sort and paginate.
 *
 * Applied in process rather than in SQL because most of what an operator
 * filters on - online, heating, faulted - is derived from the current clock
 * and the newest frame, not stored in a column. Pushing it into SQL would mean
 * duplicating the derivation rules in two languages and keeping them in step.
 */
export async function listDevices(
  options: ListOptions = {},
  now: number = Date.now(),
): Promise<ListResult> {
  const all = await listHeaterViews(now);

  const search = options.search?.trim().toLowerCase() ?? "";
  const status = options.status ?? "all";
  const connection = options.connection ?? "all";
  const kind = options.kind ?? "all";
  const room = options.room ?? "";

  let filtered = all.filter((device) => {
    if (search) {
      const haystack = [
        device.name,
        device.serialNumber,
        device.model,
        device.roomName,
        device.homeName,
        device.bluetoothName,
        device.firmwareVersion,
        device.telemetry?.ip,
        device.localAddress,
        device.homeSsid,
        ...device.channels.map((channel) => channel.name),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    switch (status) {
      case "online":
        if (!device.online) return false;
        break;
      case "offline":
        if (device.online) return false;
        break;
      case "heating":
        if (!device.heating) return false;
        break;
      case "fault":
        if (device.faultCount === 0 && device.openAlertCount === 0) return false;
        break;
      case "tripped":
        if (!device.tripped) return false;
        break;
    }

    if (connection !== "all") {
      const frame = device.telemetry;
      if (!frame) return false;
      if (connection === "sta" && frame.wifi !== "STA") return false;
      if (connection === "ap" && frame.wifi !== "AP") return false;
      if (connection === "bluetooth" && !frame.bluetoothClient) return false;
    }

    if (room && device.roomId !== room) return false;

    if (kind !== "all") {
      if (!device.channels.some((channel) => channel.kind === kind && channel.enabled)) {
        return false;
      }
    }

    return true;
  });

  const dir = options.sortDir === "desc" ? -1 : 1;
  const sortBy = options.sortBy ?? "name";

  // Nulls always sort last regardless of direction: a device with no reading is
  // not "the coldest", it is simply unknown, and floating it to the top of a
  // temperature sort would bury the devices an operator actually wants to see.
  const compareNullable = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * dir;
  };

  filtered = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "status": {
        const rank = (device: DeviceView) =>
          device.online ? (device.heating ? 0 : 1) : device.offlineReason === "never_seen" ? 3 : 2;
        return (rank(a) - rank(b)) * dir || a.name.localeCompare(b.name);
      }
      case "lastSeen":
        return compareNullable(a.lastSeenAt, b.lastSeenAt) || a.name.localeCompare(b.name);
      case "temperature":
        return compareNullable(a.hottestTempC, b.hottestTempC) || a.name.localeCompare(b.name);
      case "power":
        return (
          compareNullable(a.telemetry?.totalPowerW ?? null, b.telemetry?.totalPowerW ?? null) ||
          a.name.localeCompare(b.name)
        );
      case "room":
        return (a.roomName ?? "").localeCompare(b.roomName ?? "") * dir || a.name.localeCompare(b.name);
      case "alerts":
        return (attentionScore(a) - attentionScore(b)) * dir || a.name.localeCompare(b.name);
      case "name":
      default:
        return a.name.localeCompare(b.name) * dir;
    }
  });

  const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(options.page ?? 1, 1), pageCount);
  const start = (page - 1) * pageSize;

  return {
    devices: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    pageCount,
  };
}

// ------------------------------------------------------------------- stats

export async function getStats(now: number = Date.now()): Promise<FleetStats> {
  const [devices, extras] = await Promise.all([listHeaterViews(now), getStatsExtras()]);
  return computeStats(devices, extras, now);
}

async function getStatsExtras(): Promise<{
  openAlerts: number;
  criticalAlerts: number;
  pendingCommands: number;
}> {
  const [alerts, commands] = await Promise.all([
    queryOne<{ open_count: number; critical_count: number }>(
      `SELECT count(*)::int AS open_count,
              count(*) FILTER (WHERE severity = 'critical')::int AS critical_count
       FROM alerts WHERE cleared_at IS NULL`,
    ),
    queryOne<{ pending: number }>(
      `SELECT count(*)::int AS pending FROM commands
       WHERE status = 'pending' AND expires_at > now()`,
    ),
  ]);

  return {
    openAlerts: alerts?.open_count ?? 0,
    criticalAlerts: alerts?.critical_count ?? 0,
    pendingCommands: commands?.pending ?? 0,
  };
}

export async function snapshot(
  now: number = Date.now(),
): Promise<{ now: number; devices: DeviceView[]; stats: FleetStats }> {
  const [devices, extras] = await Promise.all([listHeaterViews(now), getStatsExtras()]);
  return { now, devices, stats: computeStats(devices, extras, now) };
}

// ------------------------------------------------------------------- ingest

export interface ChannelInput {
  channelIndex: number;
  channelId?: string;
  isOn?: boolean;
  currentA?: number;
  powerW?: number;
  energyWh?: number;
  fault?: FaultCode;
}

/**
 * A channel input whose `channelId` has been resolved against the device's
 * configured channels, so downstream writers never have to guess.
 */
type ResolvedChannel = ChannelInput & { channelId: string };

export interface TelemetryInput {
  level?: HeatLevel;
  levelValue?: number;
  mode?: string;
  manual?: boolean;
  autoFan?: boolean;
  tripped?: boolean;
  climate?: boolean;
  climateTargetC?: number | null;
  totalCurrentA?: number;
  sumCurrentA?: number;
  totalPowerW?: number;
  readingSource?: string;
  meterVoltageV?: number;
  mainsVoltageV?: number;
  temp1C?: number | null;
  temp2C?: number | null;
  temp3C?: number | null;
  temp4C?: number | null;
  dhtTempC?: number | null;
  /** Temperature from the second humidity sensor (sensor board only). */
  dht2TempC?: number | null;
  avgTempC?: number | null;
  maxTempC?: number | null;
  humidity1Pct?: number | null;
  humidity2Pct?: number | null;
  humidity3Pct?: number | null;
  /** How many sensors the board reports as reading. */
  sensorsOk?: number | null;
  /** `temphum` marks the frame, and from then on the device, as a sensor board. */
  deviceType?: string | null;
  /** The board's own name; followed while the device's `name_source` is 'device'. */
  deviceName?: string;
  currentLimitA?: number | null;
  totalLimitA?: number | null;
  temperatureLimitC?: number | null;
  wifi?: WifiMode;
  ip?: string | null;
  bluetoothClient?: boolean;
  apiKeySet?: boolean;
  uptimeSeconds?: number;
  /** Measured RSSI in dBm; omitted by firmware that cannot report it. */
  rssiDbm?: number | null;
  /** RSSI of the connected Bluetooth peer in dBm; omitted when none is measured. */
  bleRssiDbm?: number | null;
  raw?: Record<string, unknown> | null;
  channels?: ChannelInput[];
}

/**
 * Writes one telemetry frame and everything that follows from it: the per-channel
 * rows, the device's `last_seen_at` and `latest_telemetry_id` pointer, the hourly
 * energy rollup, and any alerts the frame raises or clears.
 *
 * All of it in one transaction, because a frame whose channel rows are missing
 * would render as a device drawing power through no channels.
 */
export async function ingestTelemetry(
  deviceId: string,
  input: TelemetryInput,
  now: number = Date.now(),
): Promise<DeviceView | null> {
  if (!isUuid(deviceId)) return null;

  const before = await getDeviceView(deviceId, now);
  if (!before) return null;

  const settings = before.settings;
  const currentLimitA = input.currentLimitA ?? settings?.currentLimitA ?? config.defaults.currentLimitA;
  const totalLimitA = input.totalLimitA ?? settings?.totalLimitA ?? config.defaults.totalLimitA;
  const temperatureLimitC =
    input.temperatureLimitC ?? settings?.temperatureLimitC ?? config.defaults.temperatureLimitC;

  // Resolve every channel id from the device's configured channels once, here,
  // rather than at each consumer. Firmware is allowed to send only an index,
  // and an alert that knows the index but not the id would show up on the
  // dashboard with no way to say which relay it came from.
  const configByIndex = new Map(before.channels.map((channel) => [channel.channelIndex, channel]));
  const channels = (input.channels ?? []).flatMap((channel) => {
    const channelId = channel.channelId ?? configByIndex.get(channel.channelIndex)?.channelId;
    // An index the device is not configured for has nothing to attribute it to.
    return channelId ? [{ ...channel, channelId }] : [];
  });

  const recordedAt = new Date(now);

  const isSensor = before.deviceType === "temphum" || input.deviceType === SENSOR_DEVICE_TYPE;

  // Fall back to the sum of the channel currents when the meter did not report
  // a total, which is what `reading_source` is there to record.
  const channelCurrentSum = channels.reduce((sum, channel) => sum + (channel.currentA ?? 0), 0);
  const channelPowerSum = channels.reduce((sum, channel) => sum + (channel.powerW ?? 0), 0);
  const totalCurrentA = input.totalCurrentA ?? channelCurrentSum;
  const totalPowerW = input.totalPowerW ?? channelPowerSum;

  const frame = await transaction(async (client) => {
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO telemetry (
         device_id, recorded_at, level, level_value, mode, manual, auto_fan, tripped,
         climate, climate_target_c, total_current_a, sum_current_a, total_power_w,
         reading_source, meter_voltage_v, mains_voltage_v,
         temp_1_c, temp_2_c, temp_3_c, dht_temp_c, max_temp_c,
         humidity_1_pct, humidity_2_pct, humidity_3_pct,
         current_limit_a, total_limit_a, temperature_limit_c,
         wifi, ip, bluetooth_client, api_key_set, uptime_seconds,
         wifi_rssi_dbm, raw, temp_4_c, avg_temp_c, ble_rssi_dbm,
         dht_2_temp_c, sensors_ok, device_type
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
         $38,$39,$40
       ) RETURNING id`,
      [
        deviceId,
        recordedAt,
        input.level ?? "off",
        input.levelValue ?? 0,
        // The firmware's own "mode" is just the level name in capitals, and its
        // telemetry frame omits it - so fall back to the level, never to "OFF".
        input.mode ?? (input.level ?? "off").toUpperCase(),
        input.manual ?? false,
        input.autoFan ?? settings?.autoFan ?? true,
        input.tripped ?? false,
        input.climate ?? settings?.climateEnabled ?? false,
        input.climateTargetC ?? settings?.climateTargetC ?? null,
        totalCurrentA,
        input.sumCurrentA ?? channelCurrentSum,
        totalPowerW,
        input.readingSource ?? "CT SUM",
        input.meterVoltageV ?? 0,
        input.mainsVoltageV ?? settings?.mainsVoltageV ?? config.defaults.mainsVoltageV,
        input.temp1C ?? null,
        input.temp2C ?? null,
        input.temp3C ?? null,
        input.dhtTempC ?? null,
        input.maxTempC ?? null,
        input.humidity1Pct ?? null,
        input.humidity2Pct ?? null,
        input.humidity3Pct ?? null,
        currentLimitA,
        totalLimitA,
        temperatureLimitC,
        input.wifi ?? "STA",
        input.ip ?? null,
        input.bluetoothClient ?? false,
        input.apiKeySet ?? false,
        Math.max(0, Math.round(input.uptimeSeconds ?? 0)),
        // smallint column: round, and keep null meaning "not reported".
        input.rssiDbm == null ? null : Math.round(input.rssiDbm),
        input.raw ? JSON.stringify(input.raw) : null,
        input.temp4C ?? null,
        input.avgTempC ?? null,
        input.bleRssiDbm == null ? null : Math.round(input.bleRssiDbm),
        input.dht2TempC ?? null,
        input.sensorsOk == null ? null : Math.round(input.sensorsOk),
        input.deviceType ?? null,
      ],
    );

    const telemetryId = inserted.rows[0].id;

    for (const channel of channels) {
      await client.query(
        `INSERT INTO telemetry_channels (
           telemetry_id, device_id, recorded_at, channel_index, channel_id,
           is_on, current_a, power_w, energy_wh, fault
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (telemetry_id, channel_index) DO NOTHING`,
        [
          telemetryId,
          deviceId,
          recordedAt,
          channel.channelIndex,
          channel.channelId,
          channel.isOn ?? false,
          channel.currentA ?? 0,
          channel.powerW ?? 0,
          channel.energyWh ?? 0,
          channel.fault ?? "ok",
        ],
      );
    }

    await client.query(
      `UPDATE devices
         SET last_seen_at = $2, latest_telemetry_id = $3,
             local_address = COALESCE($4, local_address),
             device_type = COALESCE($5, device_type),
             name = CASE WHEN name_source = 'device' AND $6::text IS NOT NULL THEN $6 ELSE name END,
             updated_at = now()
       WHERE id = $1`,
      [
        deviceId,
        recordedAt,
        telemetryId,
        input.ip ? `http://${input.ip}` : null,
        // Only ever promotes a device to a sensor. A frame with no type, or a
        // type this server does not know, leaves the stored one alone.
        input.deviceType === SENSOR_DEVICE_TYPE ? SENSOR_DEVICE_TYPE : null,
        input.deviceName ?? null,
      ],
    );

    return { telemetryId, recordedAt };
  });

  // Energy rollup and alerts sit outside the ingest transaction on purpose: a
  // failure to roll up an hourly bucket must not discard the frame itself,
  // which is the reading we actually care about keeping.
  if (isSensor) {
    // A sensor board has no relays, no current and no protection limits; it
    // is measured against its own thresholds and logs to its own alert table.
    await evaluateSensorAlerts(deviceId, {
      t1: input.temp1C ?? null,
      t2: input.temp2C ?? null,
      t3: input.temp3C ?? null,
      t4: input.temp4C ?? null,
      h1: input.humidity1Pct ?? null,
      h2: input.humidity2Pct ?? null,
    });
  } else {
    await Promise.all([
      rollUpEnergy(deviceId, channels, before, now),
      evaluateAlerts(deviceId, {
        deviceName: before.name,
        channels,
        totalCurrentA,
        currentLimitA,
        totalLimitA,
        temperatureLimitC,
        tripped: input.tripped ?? false,
        hottestTempC: hottestOf(input),
      }),
    ]);
  }

  const after = await getDeviceView(deviceId, Date.now());
  if (after) {
    getBus().publish({
      kind: "device",
      reason: before.online ? "telemetry" : "came_online",
      device: after,
      t: Date.now(),
    });
    void publishStats();
  }
  void frame;
  return after;
}

function hottestOf(input: TelemetryInput): number | null {
  const readings = [input.temp1C, input.temp2C, input.temp3C, input.temp4C, input.dhtTempC].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  if (readings.length === 0) return input.maxTempC ?? null;
  return Math.max(...readings);
}

/**
 * Accumulates the hourly per-channel energy bucket.
 *
 * Energy is integrated from power over the gap since the device's previous
 * frame (Wh = W x hours) rather than trusting a cumulative counter from the
 * firmware, because a counter resets on every reboot and a reset would show up
 * as a large negative delta. The gap is clamped so a device returning after an
 * outage does not book hours of energy it never actually drew.
 */
async function rollUpEnergy(
  deviceId: string,
  channels: readonly ResolvedChannel[],
  before: DeviceView,
  now: number,
): Promise<void> {
  if (channels.length === 0) return;

  const previousAt = before.telemetry?.recordedAt ?? null;
  const rawGapMs = previousAt === null ? config.telemetryIntervalMs : now - previousAt;
  const gapMs = Math.min(Math.max(rawGapMs, 0), config.offlineTimeoutMs);
  const hours = gapMs / 3_600_000;

  const bucket = new Date(now);
  bucket.setMinutes(0, 0, 0);

  for (const channel of channels) {
    const powerW = channel.powerW ?? 0;
    const isOn = channel.isOn ?? false;
    const energyWh = powerW * hours;

    await query(
      `INSERT INTO energy_hourly (
         device_id, channel_index, bucket, channel_id,
         energy_wh, avg_power_w, peak_power_w, on_samples, samples
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)
       ON CONFLICT (device_id, channel_index, bucket) DO UPDATE SET
         energy_wh = energy_hourly.energy_wh + EXCLUDED.energy_wh,
         avg_power_w = (energy_hourly.avg_power_w * energy_hourly.samples + EXCLUDED.avg_power_w)
                       / (energy_hourly.samples + 1),
         peak_power_w = GREATEST(energy_hourly.peak_power_w, EXCLUDED.peak_power_w),
         on_samples = energy_hourly.on_samples + EXCLUDED.on_samples,
         samples = energy_hourly.samples + 1`,
      [
        deviceId,
        channel.channelIndex,
        bucket,
        channel.channelId,
        energyWh,
        powerW,
        powerW,
        isOn ? 1 : 0,
      ],
    );
  }
}

// ------------------------------------------------------------------- alerts

interface AlertContext {
  deviceName: string;
  channels: readonly ResolvedChannel[];
  totalCurrentA: number;
  currentLimitA: number;
  totalLimitA: number;
  temperatureLimitC: number;
  tripped: boolean;
  hottestTempC: number | null;
}

/** Human-readable text for each fault the firmware can report on a channel. */
const FAULT_TEXT: Record<Exclude<FaultCode, "ok">, { severity: AlertSeverity; message: string }> = {
  over_current: { severity: "critical", message: "Channel current exceeded its limit" },
  no_load: { severity: "warning", message: "Channel switched on but drawing no current" },
  over_temperature: { severity: "critical", message: "Channel over temperature" },
};

/**
 * Raises and clears alerts from the frame just ingested.
 *
 * Raising is idempotent: the partial unique index on (device, channel, code)
 * where `cleared_at IS NULL` means a condition that persists across a hundred
 * frames produces exactly one open alert, and `raised_at` keeps pointing at
 * when the problem actually started rather than when it was last seen.
 */
async function evaluateAlerts(deviceId: string, ctx: AlertContext): Promise<void> {
  const open: Array<{
    code: string;
    channelIndex: number | null;
    channelId: string | null;
    severity: AlertSeverity;
    message: string;
    value: number | null;
  }> = [];

  if (ctx.tripped) {
    open.push({
      code: "tripped",
      channelIndex: null,
      channelId: null,
      severity: "critical",
      message: "Protection tripped - the board has cut power",
      value: null,
    });
  }

  if (ctx.hottestTempC !== null && ctx.hottestTempC > ctx.temperatureLimitC) {
    open.push({
      code: "over_temperature",
      channelIndex: null,
      channelId: null,
      severity: "critical",
      message: `Temperature ${ctx.hottestTempC.toFixed(1)}C is above the ${ctx.temperatureLimitC}C limit`,
      value: ctx.hottestTempC,
    });
  }

  if (ctx.totalCurrentA > ctx.totalLimitA) {
    open.push({
      code: "total_over_current",
      channelIndex: null,
      channelId: null,
      severity: "critical",
      message: `Total draw ${ctx.totalCurrentA.toFixed(2)}A is above the ${ctx.totalLimitA}A limit`,
      value: ctx.totalCurrentA,
    });
  } else if (ctx.totalCurrentA > ctx.totalLimitA * config.warnAtFractionOfLimit) {
    open.push({
      code: "total_current_high",
      channelIndex: null,
      channelId: null,
      severity: "warning",
      message: `Total draw ${ctx.totalCurrentA.toFixed(2)}A is near the ${ctx.totalLimitA}A limit`,
      value: ctx.totalCurrentA,
    });
  }

  for (const channel of ctx.channels) {
    const fault = channel.fault ?? "ok";
    if (fault !== "ok") {
      const faultText = FAULT_TEXT[fault];
      open.push({
        code: fault,
        channelIndex: channel.channelIndex,
        channelId: channel.channelId,
        severity: faultText.severity,
        message: faultText.message,
        value: channel.currentA ?? null,
      });
    }

    const currentA = channel.currentA ?? 0;
    if (fault === "ok" && currentA > ctx.currentLimitA) {
      open.push({
        code: "channel_over_current",
        channelIndex: channel.channelIndex,
        channelId: channel.channelId,
        severity: "critical",
        message: `Channel draw ${currentA.toFixed(2)}A is above the ${ctx.currentLimitA}A limit`,
        value: currentA,
      });
    }
  }

  for (const alert of open) {
    const row = await queryOne<AlertRow>(
      `INSERT INTO alerts (device_id, channel_index, channel_id, code, severity, message, value)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (device_id, COALESCE(channel_index::integer, -1), code)
         WHERE cleared_at IS NULL DO NOTHING
       RETURNING *`,
      [
        deviceId,
        alert.channelIndex,
        alert.channelId,
        alert.code,
        alert.severity,
        alert.message,
        alert.value,
      ],
    );
    // NULL only when the unique index caught a duplicate of an alert that is
    // already open - nothing changed, so nothing to tell a client about.
    if (row) {
      getBus().publish({ kind: "alert", alert: mapAlertRow(row, ctx.deviceName), t: Date.now() });
    }
  }

  // Anything open that this frame did not re-assert has resolved. Clearing is
  // driven by the absence of the condition rather than by an explicit "all
  // clear" message, which a device that has just rebooted would never send.
  const stillOpen = open.map((alert) => `${alert.channelIndex ?? -1}:${alert.code}`);
  await query(
    `UPDATE alerts SET cleared_at = now()
     WHERE device_id = $1 AND cleared_at IS NULL
       AND (COALESCE(channel_index, -1)::text || ':' || code) <> ALL($2)`,
    [deviceId, stillOpen.length > 0 ? stillOpen : [""]],
  );
}

/** Row shape shared by every query against `alerts`, with or without the device join. */
interface AlertRow {
  id: string;
  device_id: string;
  channel_index: number | null;
  channel_id: string | null;
  code: string;
  severity: AlertSeverity;
  message: string;
  value: number | null;
  raised_at: Date;
  cleared_at: Date | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
}

/**
 * `deviceName` is passed in rather than read off the row because the INSERT
 * that raises a new alert has no join to `devices` - the caller already knows
 * the name from the device view it just fetched.
 */
function mapAlertRow(row: AlertRow, deviceName: string): DeviceAlert {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName,
    channelIndex: row.channel_index,
    channelId: row.channel_id,
    code: row.code,
    severity: row.severity,
    message: row.message,
    value: num(row.value),
    raisedAt: msRequired(row.raised_at),
    clearedAt: ms(row.cleared_at),
    acknowledgedAt: ms(row.acknowledged_at),
    acknowledgedBy: row.acknowledged_by,
  };
}

export async function listAlerts(
  options: {
    deviceId?: string;
    open?: boolean;
    severity?: AlertSeverity;
    from?: number;
    to?: number;
    limit?: number;
  } = {},
): Promise<DeviceAlert[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.deviceId) {
    if (!isUuid(options.deviceId)) return [];
    params.push(options.deviceId);
    conditions.push(`a.device_id = $${params.length}`);
  }
  if (options.open === true) conditions.push("a.cleared_at IS NULL");
  if (options.open === false) conditions.push("a.cleared_at IS NOT NULL");
  if (options.severity) {
    params.push(options.severity);
    conditions.push(`a.severity = $${params.length}`);
  }
  if (options.from !== undefined) {
    params.push(new Date(options.from));
    conditions.push(`a.raised_at >= $${params.length}`);
  }
  if (options.to !== undefined) {
    params.push(new Date(options.to));
    conditions.push(`a.raised_at <= $${params.length}`);
  }

  params.push(Math.min(options.limit ?? config.history.maxAlerts, 1000));

  const rows = await query<AlertRow & { device_name: string }>(
    `SELECT a.*, d.name AS device_name
     FROM alerts a JOIN devices d ON d.id = a.device_id
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY a.raised_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => mapAlertRow(row, row.device_name));
}

export async function acknowledgeAlert(alertId: string, userId: string | null): Promise<boolean> {
  if (!isUuid(alertId)) return false;
  const rows = await query(
    `UPDATE alerts SET acknowledged_at = now(), acknowledged_by = $2
     WHERE id = $1 AND acknowledged_at IS NULL RETURNING id`,
    [alertId, userId && isUuid(userId) ? userId : null],
  );
  if (rows.length > 0) void publishStats();
  return rows.length > 0;
}

// ----------------------------------------------------------------- commands

export async function issueCommand(
  deviceId: string,
  command: string,
  issuedBy: string | null,
): Promise<DeviceCommand | null> {
  if (!isUuid(deviceId)) return null;
  const row = await queryOne<CommandRow>(
    `INSERT INTO commands (device_id, issued_by, command)
     VALUES ($1,$2,$3) RETURNING *`,
    [deviceId, issuedBy && isUuid(issuedBy) ? issuedBy : null, command],
  );
  if (!row) return null;

  const device = await getDeviceView(deviceId);
  if (device) {
    getBus().publish({ kind: "device", reason: "command", device, t: Date.now() });
  }
  void publishStats();
  return mapCommand(row);
}

interface CommandRow {
  id: string;
  device_id: string;
  issued_by: string | null;
  command: string;
  status: CommandStatus;
  reply: string | null;
  error: string | null;
  created_at: Date;
  delivered_at: Date | null;
  completed_at: Date | null;
  expires_at: Date;
}

function mapCommand(row: CommandRow): DeviceCommand {
  return {
    id: row.id,
    deviceId: row.device_id,
    issuedBy: row.issued_by,
    command: row.command,
    status: row.status,
    reply: row.reply,
    error: row.error,
    createdAt: msRequired(row.created_at),
    deliveredAt: ms(row.delivered_at),
    completedAt: ms(row.completed_at),
    expiresAt: msRequired(row.expires_at),
  };
}

export async function listCommands(deviceId: string, limit = 50): Promise<DeviceCommand[]> {
  if (!isUuid(deviceId)) return [];
  const rows = await query<CommandRow>(
    `SELECT * FROM commands WHERE device_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [deviceId, Math.min(limit, config.history.maxCommands)],
  );
  return rows.map(mapCommand);
}

/**
 * Hands the device its queued commands and marks them delivered in one
 * statement, so two concurrent polls cannot both collect the same command.
 */
export async function claimPendingCommands(deviceId: string): Promise<DeviceCommand[]> {
  if (!isUuid(deviceId)) return [];
  const rows = await query<CommandRow>(
    `UPDATE commands SET status = 'delivered', delivered_at = now()
     WHERE id IN (
       SELECT id FROM commands
       WHERE device_id = $1 AND status = 'pending' AND expires_at > now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [deviceId],
  );
  return rows.map(mapCommand);
}

export async function completeCommand(
  commandId: string,
  status: Extract<CommandStatus, "acked" | "failed">,
  reply: string | null,
  error: string | null,
): Promise<DeviceCommand | null> {
  if (!isUuid(commandId)) return null;
  const row = await queryOne<CommandRow>(
    `UPDATE commands SET status = $2, reply = $3, error = $4, completed_at = now()
     WHERE id = $1 RETURNING *`,
    [commandId, status, reply, error],
  );
  if (row) {
    void publishStats();
    // The device's own reply is a change worth showing live - the operator
    // watching this device's page should see "acked" the moment the board
    // says so, not on the next slow poll or telemetry frame.
    const device = await getDeviceView(row.device_id);
    if (device) getBus().publish({ kind: "device", reason: "command", device, t: Date.now() });
  }
  return row ? mapCommand(row) : null;
}

/** Ages out commands the device never collected. Called by the sweeper. */
export async function expireStaleCommands(): Promise<number> {
  const rows = await query(
    `UPDATE commands SET status = 'expired'
     WHERE status IN ('pending','delivered') AND expires_at <= now() RETURNING id`,
  );
  return rows.length;
}

// ------------------------------------------------------------------ history

export interface TelemetryPoint {
  t: number;
  level: HeatLevel;
  levelValue: number;
  tripped: boolean;
  climate: boolean;
  climateTargetC: number | null;
  totalCurrentA: number;
  totalPowerW: number;
  mainsVoltageV: number;
  temp1C: number | null;
  temp2C: number | null;
  temp3C: number | null;
  temp4C: number | null;
  dhtTempC: number | null;
  avgTempC: number | null;
  maxTempC: number | null;
  humidity1Pct: number | null;
  humidity2Pct: number | null;
  humidity3Pct: number | null;
  temperatureLimitC: number | null;
  wifi: WifiMode;
  bluetoothClient: boolean;
  uptimeSeconds: number;
  /** Signal strength over time, null wherever the firmware reported none. */
  rssiDbm: number | null;
  bleRssiDbm: number | null;
}

/**
 * Telemetry for a window, thinned to at most `maxPoints`.
 *
 * The thinning happens in SQL with `row_number()` so a 30-day range moves a few
 * hundred rows over the wire rather than a quarter of a million. Every returned
 * point is a real reading, not an average: an averaged spike is a spike that
 * never appears, and spikes are the entire reason to look at this chart.
 */
export async function getTelemetrySeries(
  deviceId: string,
  from: number,
  to: number,
  maxPoints = config.history.maxSamples,
): Promise<TelemetryPoint[]> {
  if (!isUuid(deviceId)) return [];

  const rows = await query<TelemetryRow & { total_rows: number }>(
    `WITH windowed AS (
       SELECT *, count(*) OVER () AS total_rows,
              row_number() OVER (ORDER BY recorded_at) AS rn
       FROM telemetry
       WHERE device_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
     )
     SELECT * FROM windowed
     WHERE rn % GREATEST(1, (total_rows / $4)::int) = 0 OR rn = total_rows
     ORDER BY recorded_at`,
    [deviceId, new Date(from), new Date(to), Math.max(1, maxPoints)],
  );

  return rows.map((row) => ({
    t: msRequired(row.recorded_at),
    level: row.level,
    levelValue: row.level_value,
    tripped: row.tripped,
    climate: row.climate,
    climateTargetC: num(row.climate_target_c),
    totalCurrentA: numRequired(row.total_current_a),
    totalPowerW: numRequired(row.total_power_w),
    mainsVoltageV: numRequired(row.mains_voltage_v),
    temp1C: num(row.temp_1_c),
    temp2C: num(row.temp_2_c),
    temp3C: num(row.temp_3_c),
    temp4C: num(row.temp_4_c),
    dhtTempC: num(row.dht_temp_c),
    avgTempC: num(row.avg_temp_c),
    maxTempC: num(row.max_temp_c),
    humidity1Pct: num(row.humidity_1_pct),
    humidity2Pct: num(row.humidity_2_pct),
    humidity3Pct: num(row.humidity_3_pct),
    temperatureLimitC: num(row.temperature_limit_c),
    wifi: row.wifi,
    bluetoothClient: row.bluetooth_client,
    uptimeSeconds: row.uptime_seconds,
    rssiDbm: num(row.wifi_rssi_dbm),
    bleRssiDbm: num(row.ble_rssi_dbm),
  }));
}

/**
 * A period in which the board was not reporting.
 *
 * `lastSeenAt` is the board's final frame before it went quiet, which is the
 * moment it actually went offline; the portal only notices `offlineTimeoutMs`
 * later. `backAt` is the first frame after the gap, or null while the outage
 * is still running. `from` / `to` are the same instants clamped to the
 * requested window so a chart can shade them directly.
 */
export interface DeviceOutage {
  lastSeenAt: number | null;
  backAt: number | null;
  from: number;
  to: number | null;
}

/**
 * Every gap in a device's telemetry longer than the offline timeout, inside a
 * window. Derived from the frames themselves rather than from the sweeper's
 * in-memory state, so it is correct across server restarts and for history
 * that predates this feature. A trailing gap that is still open at `now`
 * is reported with `to: null`.
 */
export async function getOutages(
  deviceId: string,
  from: number,
  to: number,
  now: number = Date.now(),
  timeoutMs: number = config.offlineTimeoutMs,
): Promise<DeviceOutage[]> {
  if (!isUuid(deviceId)) return [];
  const end = Math.min(to, now);
  if (end <= from) return [];

  const [before, gaps, edges] = await Promise.all([
    queryOne<{ recorded_at: Date }>(
      `SELECT recorded_at FROM telemetry
       WHERE device_id = $1 AND recorded_at < $2
       ORDER BY recorded_at DESC LIMIT 1`,
      [deviceId, new Date(from)],
    ),
    query<{ prev: Date; recorded_at: Date }>(
      `WITH pts AS (
         SELECT recorded_at, lag(recorded_at) OVER (ORDER BY recorded_at) AS prev
         FROM telemetry
         WHERE device_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
       )
       SELECT prev, recorded_at FROM pts
       WHERE prev IS NOT NULL
         AND recorded_at - prev > make_interval(secs => $4)
       ORDER BY recorded_at`,
      [deviceId, new Date(from), new Date(end), timeoutMs / 1000],
    ),
    queryOne<{ first: Date | null; last: Date | null }>(
      `SELECT min(recorded_at) AS first, max(recorded_at) AS last FROM telemetry
       WHERE device_id = $1 AND recorded_at >= $2 AND recorded_at <= $3`,
      [deviceId, new Date(from), new Date(end)],
    ),
  ]);

  const outages: DeviceOutage[] = [];
  const beforeAt = ms(before?.recorded_at ?? null);
  const firstAt = ms(edges?.first ?? null);
  const lastAt = ms(edges?.last ?? null);

  // `to: null` means the outage is still running at `now`. A gap that reaches
  // the end of a window that closed in the past is clamped to that end
  // instead: whether the board came back afterwards is outside the window.
  const openEnd = end < now ? end : null;

  // Leading gap: the board was already silent when the window opened, or
  // first reported well after it. With no frame on either side nothing is
  // known, and "unknown" is not "offline".
  if (beforeAt !== null || firstAt !== null) {
    const silentFrom = beforeAt ?? from;
    const contact = firstAt ?? end;
    if (contact - silentFrom > timeoutMs) {
      outages.push({ lastSeenAt: beforeAt, backAt: firstAt, from, to: firstAt ?? openEnd });
    }
  }

  for (const gap of gaps) {
    const silentAt = msRequired(gap.prev);
    const backAt = msRequired(gap.recorded_at);
    outages.push({ lastSeenAt: silentAt, backAt, from: silentAt, to: backAt });
  }

  // Trailing gap: the board has been quiet since its last frame in the window.
  if (lastAt !== null && end - lastAt > timeoutMs) {
    outages.push({ lastSeenAt: lastAt, backAt: null, from: lastAt, to: openEnd });
  }

  return outages;
}

export interface ChannelSeriesPoint {
  t: number;
  channelIndex: number;
  channelId: string;
  isOn: boolean;
  currentA: number;
  powerW: number;
  fault: FaultCode;
}

export async function getChannelSeries(
  deviceId: string,
  from: number,
  to: number,
  maxPointsPerChannel = 500,
): Promise<ChannelSeriesPoint[]> {
  if (!isUuid(deviceId)) return [];

  const rows = await query<TelemetryChannelRow & { rn: number; total_rows: number }>(
    `WITH windowed AS (
       SELECT *,
              count(*) OVER (PARTITION BY channel_index) AS total_rows,
              row_number() OVER (PARTITION BY channel_index ORDER BY recorded_at) AS rn
       FROM telemetry_channels
       WHERE device_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
     )
     SELECT * FROM windowed
     WHERE rn % GREATEST(1, (total_rows / $4)::int) = 0 OR rn = total_rows
     ORDER BY recorded_at, channel_index`,
    [deviceId, new Date(from), new Date(to), Math.max(1, maxPointsPerChannel)],
  );

  return rows.map((row) => ({
    t: msRequired(row.recorded_at),
    channelIndex: row.channel_index,
    channelId: row.channel_id,
    isOn: row.is_on,
    currentA: numRequired(row.current_a),
    powerW: numRequired(row.power_w),
    fault: row.fault,
  }));
}

export async function getEnergyBuckets(
  deviceId: string,
  from: number,
  to: number,
): Promise<EnergyBucket[]> {
  if (!isUuid(deviceId)) return [];
  const rows = await query<{
    device_id: string;
    channel_index: number;
    channel_id: string;
    bucket: Date;
    energy_wh: number;
    avg_power_w: number;
    peak_power_w: number;
    on_samples: number;
    samples: number;
  }>(
    `SELECT * FROM energy_hourly
     WHERE device_id = $1 AND bucket >= $2 AND bucket <= $3
     ORDER BY bucket, channel_index`,
    [deviceId, new Date(from), new Date(to)],
  );

  return rows.map((row) => ({
    deviceId: row.device_id,
    channelIndex: row.channel_index,
    channelId: row.channel_id,
    bucket: msRequired(row.bucket),
    energyWh: numRequired(row.energy_wh),
    avgPowerW: numRequired(row.avg_power_w),
    peakPowerW: numRequired(row.peak_power_w),
    onSamples: row.on_samples,
    samples: row.samples,
  }));
}

/** Fleet-wide hourly energy, summed across devices and channels. */
export async function getFleetEnergy(
  from: number,
  to: number,
): Promise<Array<{ bucket: number; energyWh: number; avgPowerW: number; peakPowerW: number }>> {
  const rows = await query<{
    bucket: Date;
    energy_wh: number;
    avg_power_w: number;
    peak_power_w: number;
  }>(
    `SELECT bucket,
            sum(energy_wh) AS energy_wh,
            sum(avg_power_w) AS avg_power_w,
            max(peak_power_w) AS peak_power_w
     FROM energy_hourly
     WHERE bucket >= $1 AND bucket <= $2
     GROUP BY bucket ORDER BY bucket`,
    [new Date(from), new Date(to)],
  );

  return rows.map((row) => ({
    bucket: msRequired(row.bucket),
    energyWh: numRequired(row.energy_wh),
    avgPowerW: numRequired(row.avg_power_w),
    peakPowerW: numRequired(row.peak_power_w),
  }));
}

/** Energy consumed per device over a window, for the analytics ranking. */
export async function getEnergyByDevice(
  from: number,
  to: number,
): Promise<Array<{ deviceId: string; deviceName: string; energyWh: number; peakPowerW: number }>> {
  const rows = await query<{
    device_id: string;
    device_name: string;
    energy_wh: number;
    peak_power_w: number;
  }>(
    `SELECT e.device_id, d.name AS device_name,
            sum(e.energy_wh) AS energy_wh,
            max(e.peak_power_w) AS peak_power_w
     FROM energy_hourly e JOIN devices d ON d.id = e.device_id
     WHERE e.bucket >= $1 AND e.bucket <= $2
     GROUP BY e.device_id, d.name
     ORDER BY energy_wh DESC`,
    [new Date(from), new Date(to)],
  );

  return rows.map((row) => ({
    deviceId: row.device_id,
    deviceName: row.device_name,
    energyWh: numRequired(row.energy_wh),
    peakPowerW: numRequired(row.peak_power_w),
  }));
}

/** Energy per channel kind, so heating can be separated from fans and lights. */
export async function getEnergyByKind(
  from: number,
  to: number,
): Promise<Array<{ kind: string; energyWh: number }>> {
  const rows = await query<{ kind: string; energy_wh: number }>(
    `SELECT c.kind::text AS kind, sum(e.energy_wh) AS energy_wh
     FROM energy_hourly e
     JOIN device_channels c
       ON c.device_id = e.device_id AND c.channel_index = e.channel_index
     WHERE e.bucket >= $1 AND e.bucket <= $2
     GROUP BY c.kind
     ORDER BY energy_wh DESC`,
    [new Date(from), new Date(to)],
  );
  return rows.map((row) => ({ kind: row.kind, energyWh: numRequired(row.energy_wh) }));
}

/** How often each alert code fired in a window, for the reliability view. */
export async function getAlertCounts(
  from: number,
  to: number,
): Promise<Array<{ code: string; severity: AlertSeverity; count: number; devices: number }>> {
  const rows = await query<{
    code: string;
    severity: AlertSeverity;
    count: number;
    devices: number;
  }>(
    `SELECT code, severity, count(*)::int AS count, count(DISTINCT device_id)::int AS devices
     FROM alerts
     WHERE raised_at >= $1 AND raised_at <= $2
     GROUP BY code, severity
     ORDER BY count DESC`,
    [new Date(from), new Date(to)],
  );
  return rows.map((row) => ({
    code: row.code,
    severity: row.severity,
    count: row.count,
    devices: row.devices,
  }));
}

/** Fleet temperature envelope per hour, for the historical temperature chart. */
export async function getTemperatureHistory(
  from: number,
  to: number,
): Promise<Array<{ bucket: number; avgC: number | null; maxC: number | null; minC: number | null }>> {
  const rows = await query<{
    bucket: Date;
    avg_c: number | null;
    max_c: number | null;
    min_c: number | null;
  }>(
    `SELECT date_trunc('hour', recorded_at) AS bucket,
            avg(GREATEST(
              COALESCE(temp_1_c, -999), COALESCE(temp_2_c, -999),
              COALESCE(temp_3_c, -999), COALESCE(temp_4_c, -999),
              COALESCE(dht_temp_c, -999))) AS avg_c,
            max(GREATEST(
              COALESCE(temp_1_c, -999), COALESCE(temp_2_c, -999),
              COALESCE(temp_3_c, -999), COALESCE(temp_4_c, -999),
              COALESCE(dht_temp_c, -999))) AS max_c,
            min(NULLIF(LEAST(
              COALESCE(temp_1_c, 999), COALESCE(temp_2_c, 999),
              COALESCE(temp_3_c, 999), COALESCE(temp_4_c, 999),
              COALESCE(dht_temp_c, 999)), 999)) AS min_c
     FROM telemetry
     WHERE recorded_at >= $1 AND recorded_at <= $2
     GROUP BY 1 ORDER BY 1`,
    [new Date(from), new Date(to)],
  );

  // -999 is the sentinel the GREATEST() above produces when every probe on a
  // frame was null; it means "no reading", not a temperature.
  const clean = (value: number | null): number | null =>
    value === null || value <= -900 ? null : value;

  return rows.map((row) => ({
    bucket: msRequired(row.bucket),
    avgC: clean(num(row.avg_c)),
    maxC: clean(num(row.max_c)),
    minC: clean(num(row.min_c)),
  }));
}

// ---------------------------------------------------------------- audit log

export async function recordAudit(
  entry: {
    userId?: string | null;
    deviceId?: string | null;
    action: string;
    detail?: Record<string, unknown> | null;
    ip?: string | null;
  },
): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, device_id, action, detail, ip)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      entry.userId && isUuid(entry.userId) ? entry.userId : null,
      entry.deviceId && isUuid(entry.deviceId) ? entry.deviceId : null,
      entry.action,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.ip ?? null,
    ],
  );
}

export async function listAudit(
  options: { deviceId?: string; limit?: number } = {},
): Promise<AuditEntry[]> {
  const params: unknown[] = [];
  let where = "";
  if (options.deviceId) {
    if (!isUuid(options.deviceId)) return [];
    params.push(options.deviceId);
    where = `WHERE a.device_id = $${params.length}`;
  }
  params.push(Math.min(options.limit ?? 100, 500));

  const rows = await query<{
    id: number;
    user_id: string | null;
    user_name: string | null;
    device_id: string | null;
    device_name: string | null;
    action: string;
    detail: Record<string, unknown> | null;
    ip: string | null;
    created_at: Date;
  }>(
    `SELECT a.*, u.name AS user_name, d.name AS device_name
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN devices d ON d.id = a.device_id
     ${where}
     ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    deviceId: row.device_id,
    deviceName: row.device_name,
    action: row.action,
    detail: row.detail,
    ip: row.ip,
    createdAt: msRequired(row.created_at),
  }));
}

// ------------------------------------------------------- devices and settings

export interface RegisterInput {
  name: string;
  serialNumber: string;
  firmwareVersion?: string | null;
  model?: string;
  bluetoothName?: string;
  bluetoothAddress?: string | null;
  homeSsid?: string | null;
  localAddress?: string | null;
  homeId?: string;
  roomId?: string | null;
  deviceKey?: string;
  channels?: Array<Omit<ChannelConfig, "calibration" | "enabled"> & {
    calibration?: number;
    enabled?: boolean;
  }>;
}

const DEFAULT_CHANNELS: ChannelConfig[] = [
  { channelIndex: 0, channelId: "h1", name: "Heater 1", kind: "heater", relayPin: 25, ctPin: 36, calibration: 1, enabled: true },
  { channelIndex: 1, channelId: "h2", name: "Heater 2", kind: "heater", relayPin: 15, ctPin: 39, calibration: 1, enabled: true },
  { channelIndex: 2, channelId: "h3", name: "Heater 3", kind: "heater", relayPin: 2, ctPin: 34, calibration: 1, enabled: true },
  { channelIndex: 3, channelId: "h4", name: "Heater 4", kind: "heater", relayPin: 4, ctPin: 35, calibration: 1, enabled: true },
  { channelIndex: 4, channelId: "fan", name: "Fan", kind: "fan", relayPin: 18, ctPin: 32, calibration: 1, enabled: true },
  { channelIndex: 5, channelId: "light", name: "Light", kind: "light", relayPin: 19, ctPin: 33, calibration: 1, enabled: true },
];

export function hashDeviceKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Registers a heater, or re-registers one that already exists.
 *
 * Re-registration is matched on serial number and refreshes firmware and
 * network details without disturbing the device's history, so a board that
 * reboots after an update does not appear as a second device. The board's name
 * replaces the stored one only while `name_source` is 'device'.
 */
export async function registerDevice(
  input: RegisterInput,
): Promise<{ device: DeviceView; deviceKey: string | null; created: boolean } | null> {
  const deviceKey = input.deviceKey ?? randomBytes(24).toString("hex");
  const keyHash = hashDeviceKey(deviceKey);

  const result = await transaction(async (client) => {
    // Every device belongs to a home; fall back to the only one that exists
    // rather than inventing a placeholder home the operator never created.
    const home = await client.query<{ id: string }>(
      input.homeId
        ? `SELECT id FROM homes WHERE id = $1`
        : `SELECT id FROM homes ORDER BY created_at LIMIT 1`,
      input.homeId ? [input.homeId] : [],
    );
    const homeId = home.rows[0]?.id;
    if (!homeId) return null;

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM devices WHERE serial_number = $1`,
      [input.serialNumber],
    );

    if (existing.rows[0]) {
      const id = existing.rows[0].id;
      await client.query(
        // The board's name is followed only until someone renames the device
        // on the portal; after that the portal's name wins.
        `UPDATE devices SET
           name = CASE WHEN name_source = 'device' THEN $8 ELSE name END,
           firmware_version = COALESCE($2, firmware_version),
           bluetooth_name = COALESCE($3, bluetooth_name),
           bluetooth_address = COALESCE($4, bluetooth_address),
           home_ssid = COALESCE($5, home_ssid),
           local_address = COALESCE($6, local_address),
           device_key_hash = $7, device_key_set_at = now(),
           updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.firmwareVersion ?? null,
          input.bluetoothName ?? null,
          input.bluetoothAddress ?? null,
          input.homeSsid ?? null,
          input.localAddress ?? null,
          keyHash,
          input.name,
        ],
      );
      return { id, created: false };
    }

    const created = await client.query<{ id: string }>(
      `INSERT INTO devices (
         home_id, room_id, name, bluetooth_name, bluetooth_address, serial_number,
         firmware_version, model, home_ssid, local_address, device_key_hash, device_key_set_at,
         device_type
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12)
       RETURNING id`,
      [
        homeId,
        input.roomId && isUuid(input.roomId) ? input.roomId : null,
        input.name,
        input.bluetoothName ?? "HEATER_VER1",
        input.bluetoothAddress ?? null,
        input.serialNumber,
        input.firmwareVersion ?? null,
        input.model ?? "HEATER Ver1",
        input.homeSsid ?? null,
        input.localAddress ?? null,
        keyHash,
        isSensorModel(input.model) ? SENSOR_DEVICE_TYPE : "heater",
      ],
    );

    const id = created.rows[0].id;
    // A sensor board has no relays, so it gets no channel rows.
    const channels = input.channels ?? (isSensorModel(input.model) ? [] : DEFAULT_CHANNELS);

    for (const channel of channels) {
      await client.query(
        `INSERT INTO device_channels (
           device_id, channel_index, channel_id, name, kind, relay_pin, ct_pin, calibration, enabled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (device_id, channel_index) DO NOTHING`,
        [
          id,
          channel.channelIndex,
          channel.channelId,
          channel.name,
          channel.kind,
          channel.relayPin,
          channel.ctPin,
          channel.calibration ?? 1,
          channel.enabled ?? true,
        ],
      );
    }

    await client.query(
      `INSERT INTO device_settings (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`,
      [id],
    );

    return { id, created: true };
  });

  if (!result) return null;

  const device = await getDeviceView(result.id);
  if (!device) return null;

  getBus().publish({
    kind: "device",
    reason: result.created ? "registered" : "updated",
    device,
    t: Date.now(),
  });
  void publishStats();

  return { device, deviceKey, created: result.created };
}

// ------------------------------------------------- website-first provisioning
//
// Every board ships the same firmware image, so nothing per-device is compiled
// in. The board derives its serial from the ESP32 MAC (HTR-XXXXXX), the
// operator adds that serial on the portal, and the board claims the row the
// first time it reaches the server. Until it does, `device_key_hash` is NULL:
// the row exists so it can be named and placed, but nothing can post telemetry
// as it.

function normaliseSerial(serial: string): string {
  return serial.trim().toUpperCase();
}

export interface AddDeviceInput {
  name: string;
  serialNumber: string;
  model?: string | null;
  roomId?: string | null;
  homeId?: string;
}

export type AddDeviceResult =
  | { ok: true; device: DeviceView }
  | { ok: false; reason: "no_home" | "serial_exists"; device?: DeviceView };

/** Operator adds a device that a board will claim later. */
export async function addDevice(input: AddDeviceInput): Promise<AddDeviceResult> {
  const serial = normaliseSerial(input.serialNumber);

  const result = await transaction(async (client) => {
    const home = await client.query<{ id: string }>(
      input.homeId
        ? `SELECT id FROM homes WHERE id = $1`
        : `SELECT id FROM homes ORDER BY created_at LIMIT 1`,
      input.homeId ? [input.homeId] : [],
    );
    const homeId = home.rows[0]?.id;
    if (!homeId) return { ok: false as const, reason: "no_home" as const };

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM devices WHERE upper(serial_number) = $1`,
      [serial],
    );
    if (existing.rows[0]) {
      return { ok: false as const, reason: "serial_exists" as const, id: existing.rows[0].id };
    }

    const created = await client.query<{ id: string }>(
      // Named by the operator who added it, so the board's name does not replace it.
      `INSERT INTO devices (home_id, room_id, name, serial_number, model, device_type, name_source)
       VALUES ($1,$2,$3,$4,$5,$6,'portal')
       RETURNING id`,
      [
        homeId,
        input.roomId && isUuid(input.roomId) ? input.roomId : null,
        input.name,
        serial,
        input.model?.trim() || "HEATER Ver1",
        isSensorModel(input.model) ? SENSOR_DEVICE_TYPE : "heater",
      ],
    );
    const id = created.rows[0].id;

    for (const channel of isSensorModel(input.model) ? [] : DEFAULT_CHANNELS) {
      await client.query(
        `INSERT INTO device_channels (
           device_id, channel_index, channel_id, name, kind, relay_pin, ct_pin, calibration, enabled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (device_id, channel_index) DO NOTHING`,
        [
          id,
          channel.channelIndex,
          channel.channelId,
          channel.name,
          channel.kind,
          channel.relayPin,
          channel.ctPin,
          channel.calibration,
          channel.enabled,
        ],
      );
    }
    await client.query(
      `INSERT INTO device_settings (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`,
      [id],
    );
    // The board may already have been knocking; it is adopted now.
    await client.query(`DELETE FROM device_claim_requests WHERE serial_number = $1`, [serial]);

    return { ok: true as const, id };
  });

  if (!result.ok) {
    if (result.reason === "serial_exists") {
      const device = (await getDeviceView(result.id)) ?? undefined;
      return { ok: false, reason: "serial_exists", device };
    }
    return { ok: false, reason: "no_home" };
  }

  const device = await getDeviceView(result.id);
  if (!device) return { ok: false, reason: "no_home" };

  getBus().publish({ kind: "device", reason: "registered", device, t: Date.now() });
  void publishStats();
  return { ok: true, device };
}

export interface ClaimInput {
  serialNumber: string;
  firmwareVersion?: string | null;
  model?: string | null;
  bluetoothName?: string | null;
  bluetoothAddress?: string | null;
  homeSsid?: string | null;
  localAddress?: string | null;
  ip?: string | null;
}

export type ClaimResult =
  | { status: "paired"; device: DeviceView; deviceKey: string }
  | { status: "already_paired"; device: DeviceView }
  | { status: "unknown" };

/**
 * A board presents its serial. If an operator has added it and no key has
 * been issued yet, mint one and hand it over - exactly once. A serial nobody
 * has added is remembered in `device_claim_requests` so the Add device form
 * can offer it; a serial that already holds a key is refused until the
 * operator resets the pairing, so a second board cannot take over a device by
 * guessing its serial.
 */
export async function claimDevice(input: ClaimInput): Promise<ClaimResult> {
  const serial = normaliseSerial(input.serialNumber);
  const deviceKey = randomBytes(24).toString("hex");
  const keyHash = hashDeviceKey(deviceKey);

  const result = await transaction(async (client) => {
    const row = await client.query<{ id: string; device_key_hash: string | null }>(
      `SELECT id, device_key_hash FROM devices WHERE upper(serial_number) = $1 FOR UPDATE`,
      [serial],
    );
    const device = row.rows[0];

    if (!device) {
      await client.query(
        `INSERT INTO device_claim_requests (
           serial_number, model, firmware_version, bluetooth_name, home_ssid, local_address, ip
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (serial_number) DO UPDATE SET
           model = COALESCE(EXCLUDED.model, device_claim_requests.model),
           firmware_version = COALESCE(EXCLUDED.firmware_version, device_claim_requests.firmware_version),
           bluetooth_name = COALESCE(EXCLUDED.bluetooth_name, device_claim_requests.bluetooth_name),
           home_ssid = COALESCE(EXCLUDED.home_ssid, device_claim_requests.home_ssid),
           local_address = COALESCE(EXCLUDED.local_address, device_claim_requests.local_address),
           ip = COALESCE(EXCLUDED.ip, device_claim_requests.ip),
           attempts = device_claim_requests.attempts + 1,
           last_seen_at = now()`,
        [
          serial,
          input.model ?? null,
          input.firmwareVersion ?? null,
          input.bluetoothName ?? null,
          input.homeSsid ?? null,
          input.localAddress ?? null,
          input.ip ?? null,
        ],
      );
      return { status: "unknown" as const };
    }

    if (device.device_key_hash) {
      return { status: "already_paired" as const, id: device.id };
    }

    await client.query(
      `UPDATE devices SET
         firmware_version = COALESCE($2, firmware_version),
         model = COALESCE($3, model),
         bluetooth_name = COALESCE($4, bluetooth_name),
         bluetooth_address = COALESCE($5, bluetooth_address),
         home_ssid = COALESCE($6, home_ssid),
         local_address = COALESCE($7, local_address),
         device_key_hash = $8, device_key_set_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [
        device.id,
        input.firmwareVersion ?? null,
        input.model ?? null,
        input.bluetoothName ?? null,
        input.bluetoothAddress ?? null,
        input.homeSsid ?? null,
        input.localAddress ?? null,
        keyHash,
      ],
    );
    await client.query(`DELETE FROM device_claim_requests WHERE serial_number = $1`, [serial]);
    return { status: "paired" as const, id: device.id };
  });

  if (result.status === "unknown") return result;

  const device = await getDeviceView(result.id);
  if (!device) return { status: "unknown" };

  if (result.status === "already_paired") return { status: "already_paired", device };

  getBus().publish({ kind: "device", reason: "updated", device, t: Date.now() });
  return { status: "paired", device, deviceKey };
}

/**
 * Forgets the device key so the next board presenting this serial is paired.
 * Used when a board is replaced or re-flashed with its NVS erased. The
 * device, its history and its settings are untouched.
 */
export async function resetDevicePairing(deviceId: string): Promise<DeviceView | null> {
  if (!isUuid(deviceId)) return null;
  await query(
    `UPDATE devices SET device_key_hash = NULL, device_key_set_at = NULL, updated_at = now()
     WHERE id = $1`,
    [deviceId],
  );
  const device = await getDeviceView(deviceId);
  if (device) getBus().publish({ kind: "device", reason: "updated", device, t: Date.now() });
  return device;
}

interface ClaimRequestRow {
  serial_number: string;
  model: string | null;
  firmware_version: string | null;
  bluetooth_name: string | null;
  home_ssid: string | null;
  local_address: string | null;
  ip: string | null;
  attempts: number;
  first_seen_at: Date;
  last_seen_at: Date;
}

/** Boards that have asked to join and are not yet added, newest first. */
export async function listClaimRequests(): Promise<ClaimRequest[]> {
  const rows = await query<ClaimRequestRow>(
    `SELECT * FROM device_claim_requests ORDER BY last_seen_at DESC LIMIT 100`,
  );
  return rows.map((row) => ({
    serialNumber: row.serial_number,
    model: text(row.model),
    firmwareVersion: text(row.firmware_version),
    bluetoothName: text(row.bluetooth_name),
    homeSsid: text(row.home_ssid),
    localAddress: text(row.local_address),
    ip: text(row.ip),
    attempts: row.attempts,
    firstSeenAt: msRequired(row.first_seen_at),
    lastSeenAt: msRequired(row.last_seen_at),
  }));
}

export async function dismissClaimRequest(serialNumber: string): Promise<boolean> {
  const rows = await query(
    `DELETE FROM device_claim_requests WHERE serial_number = $1 RETURNING serial_number`,
    [normaliseSerial(serialNumber)],
  );
  return rows.length > 0;
}

export async function updateDevice(
  deviceId: string,
  patch: {
    name?: string;
    nameSource?: NameSource;
    roomId?: string | null;
    firmwareVersion?: string | null;
  },
): Promise<DeviceView | null> {
  if (!isUuid(deviceId)) return null;

  const sets: string[] = [];
  const params: unknown[] = [deviceId];

  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  // A rename from the portal takes the name over from the board unless the
  // caller says otherwise; "device" hands it back, and the board's next frame
  // or registration puts its own name in.
  const nameSource = patch.nameSource ?? (patch.name !== undefined ? "portal" : undefined);
  if (nameSource !== undefined) {
    params.push(nameSource);
    sets.push(`name_source = $${params.length}`);
  }
  if (patch.roomId !== undefined) {
    params.push(patch.roomId && isUuid(patch.roomId) ? patch.roomId : null);
    sets.push(`room_id = $${params.length}`);
  }
  if (patch.firmwareVersion !== undefined) {
    params.push(patch.firmwareVersion);
    sets.push(`firmware_version = $${params.length}`);
  }
  if (sets.length === 0) return getDeviceView(deviceId);

  const rows = await query(
    `UPDATE devices SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`,
    params,
  );
  if (rows.length === 0) return null;

  const device = await getDeviceView(deviceId);
  if (device) getBus().publish({ kind: "device", reason: "updated", device, t: Date.now() });
  return device;
}

/**
 * Advances `last_seen_at` without writing a telemetry frame, for the heartbeat
 * endpoint. Publishes only on the offline->online edge: an already-online
 * device ticking every fifteen seconds is not news, and pushing it to every
 * connected browser would be pure noise.
 */
export async function touchDevice(
  deviceId: string,
  now: number = Date.now(),
): Promise<DeviceView | null> {
  if (!isUuid(deviceId)) return null;

  const before = await getDeviceView(deviceId, now);
  if (!before) return null;

  await query(`UPDATE devices SET last_seen_at = $2, updated_at = now() WHERE id = $1`, [
    deviceId,
    new Date(now),
  ]);

  const after = await getDeviceView(deviceId, Date.now());
  if (after && !before.online) {
    getBus().publish({ kind: "device", reason: "came_online", device: after, t: Date.now() });
    void publishStats();
  }
  return after;
}

export async function removeDevice(deviceId: string): Promise<boolean> {
  if (!isUuid(deviceId)) return false;
  const rows = await query(`DELETE FROM devices WHERE id = $1 RETURNING id`, [deviceId]);
  if (rows.length === 0) return false;
  getBus().publish({ kind: "device_removed", deviceId, t: Date.now() });
  void publishStats();
  return true;
}

export async function updateSettings(
  deviceId: string,
  patch: Partial<Omit<DeviceSettings, "deviceId" | "updatedAt">>,
  updatedBy: string | null = null,
): Promise<DeviceSettings | null> {
  if (!isUuid(deviceId)) return null;

  const columns: Record<string, unknown> = {
    current_limit_a: patch.currentLimitA,
    total_limit_a: patch.totalLimitA,
    temperature_limit_c: patch.temperatureLimitC,
    mains_voltage_v: patch.mainsVoltageV,
    auto_fan: patch.autoFan,
    climate_enabled: patch.climateEnabled,
    climate_target_c: patch.climateTargetC,
    ir_slots: patch.irSlots ? JSON.stringify(patch.irSlots) : undefined,
  };

  const sets: string[] = [];
  const params: unknown[] = [deviceId];
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  params.push(updatedBy && isUuid(updatedBy) ? updatedBy : null);
  sets.push(`updated_by = $${params.length}`, "updated_at = now()");

  // The row may not exist yet for a device provisioned outside this app.
  await query(`INSERT INTO device_settings (device_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
    deviceId,
  ]);
  await query(`UPDATE device_settings SET ${sets.join(", ")} WHERE device_id = $1`, params);

  const device = await getDeviceView(deviceId);
  if (device) getBus().publish({ kind: "device", reason: "settings", device, t: Date.now() });
  return device?.settings ?? null;
}

export async function listRooms(): Promise<
  Array<{ id: string; name: string; icon: string; deviceCount: number }>
> {
  const rows = await query<{ id: string; name: string; icon: string; device_count: number }>(
    `SELECT r.id, r.name, r.icon, count(d.id)::int AS device_count
     FROM rooms r LEFT JOIN devices d ON d.room_id = r.id
     GROUP BY r.id ORDER BY r.sort_order`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    deviceCount: row.device_count,
  }));
}

// ------------------------------------------------------------------- sweeper

/**
 * Re-evaluates liveness on a timer and pushes the transitions.
 *
 * Without this a device that simply stops transmitting would sit on the
 * dashboard as "online" until something else happened to trigger a re-render:
 * going offline is the one state change that produces no packet to react to.
 */
declare global {
  var __heaterSweeper: NodeJS.Timeout | undefined;
  var __heaterOnline: Map<string, boolean> | undefined;
}

function onlineMap(): Map<string, boolean> {
  if (!globalThis.__heaterOnline) globalThis.__heaterOnline = new Map();
  return globalThis.__heaterOnline;
}

export async function sweep(now: number = Date.now()): Promise<void> {
  const rows = await query<{ id: string; last_seen_at: Date | null }>(
    `SELECT id, last_seen_at FROM devices`,
  );

  const known = onlineMap();
  const transitioned: string[] = [];

  for (const row of rows) {
    const online = deriveLiveness(ms(row.last_seen_at), now).online;
    const previous = known.get(row.id);
    known.set(row.id, online);
    if (previous !== undefined && previous !== online) transitioned.push(row.id);
  }

  // Devices deleted since the last sweep must not linger in the map.
  const liveIds = new Set(rows.map((row) => row.id));
  for (const id of known.keys()) if (!liveIds.has(id)) known.delete(id);

  if (transitioned.length > 0) {
    const views = await listDeviceViews(now);
    for (const view of views) {
      if (!transitioned.includes(view.id)) continue;
      getBus().publish({
        kind: "device",
        reason: view.online ? "came_online" : "went_offline",
        device: view,
        t: now,
      });
    }
  }

  const expired = await expireStaleCommands();
  if (transitioned.length > 0 || expired > 0) await publishStats(now);
}

export async function publishStats(now: number = Date.now()): Promise<void> {
  try {
    const stats = await getStats(now);
    getBus().publish({ kind: "stats", stats, t: now });
  } catch (error) {
    console.error("[store] failed to publish stats:", error);
  }
}

export function startSweeper(): void {
  if (globalThis.__heaterSweeper) return;
  globalThis.__heaterSweeper = setInterval(() => {
    void sweep().catch((error) => console.error("[store] sweep failed:", error));
  }, config.sweepIntervalMs);
  globalThis.__heaterSweeper.unref?.();
}

export function stopSweeper(): void {
  if (!globalThis.__heaterSweeper) return;
  clearInterval(globalThis.__heaterSweeper);
  globalThis.__heaterSweeper = undefined;
}

/** Drops telemetry past the retention window. */
export async function pruneHistory(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - config.history.retentionMs);
  const rows = await query(`DELETE FROM telemetry WHERE recorded_at < $1 RETURNING id`, [cutoff]);
  return rows.length;
}
