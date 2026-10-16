/**
 * Domain model for the HEATER Ver1 fleet.
 *
 * Every type here mirrors a column that actually exists in the `heaterfan`
 * Postgres schema. Nothing is invented: if the firmware does not report it and
 * the database has no column for it, it does not appear on the dashboard.
 *
 * Notably absent, because the schema has no column for them: a fan-speed
 * percentage and named comfort presets. Connectivity is expressed the way the
 * hardware actually reports it - Wi-Fi mode (AP or STA), the assigned IP,
 * whether a Bluetooth client is attached, and the measured RSSI of each radio
 * when the firmware reports one.
 */

// --------------------------------------------------------------- enum mirrors
// These mirror Postgres enum types one-for-one (public.heat_level, etc.).

/** public.heat_level */
export type HeatLevel = "off" | "low" | "medium" | "high";

/** public.channel_kind */
export type ChannelKind = "heater" | "fan" | "light";

/** public.fault_code - per-channel fault derived from CT sensing. */
export type FaultCode = "ok" | "over_current" | "no_load" | "over_temperature";

/** public.alert_severity */
export type AlertSeverity = "info" | "warning" | "critical";

/** public.command_status */
export type CommandStatus = "pending" | "delivered" | "acked" | "failed" | "expired";

/** public.wifi_mode - AP = device is its own access point, STA = joined home Wi-Fi. */
export type WifiMode = "AP" | "STA";

/** public.user_role */
export type UserRole = "owner" | "member" | "viewer";

/**
 * Link quality band. These are the HeaterFan API's bands verbatim
 * (GET /devices/{id}/signal, and the legend in GET /meta) - the dashboard must
 * not invent its own, or the same link reads "Good" here and "Fair" in the
 * mobile app.
 */
export type SignalQuality = "excellent" | "good" | "fair" | "weak" | "unusable";

/**
 * Why there is no reading. Kept distinct from a weak signal: "we cannot
 * measure it" and "it is bad" are different answers for an operator.
 */
export type SignalReason = "not_reported" | "access_point_mode" | "offline";

export const HEAT_LEVELS: readonly HeatLevel[] = ["off", "low", "medium", "high"];
export const CHANNEL_KINDS: readonly ChannelKind[] = ["heater", "fan", "light"];
export const FAULT_CODES: readonly FaultCode[] = [
  "ok",
  "over_current",
  "no_load",
  "over_temperature",
];
export const ALERT_SEVERITIES: readonly AlertSeverity[] = ["info", "warning", "critical"];
export const WIFI_MODES: readonly WifiMode[] = ["AP", "STA"];
export const SIGNAL_QUALITIES: readonly SignalQuality[] = [
  "excellent",
  "good",
  "fair",
  "weak",
  "unusable",
];

/**
 * Which kind of board a device is. `heater` is every relay board; `temphum`
 * is the TEMP-HUM Ver1 sensor board, which has probes and no relays and is
 * shown on its own page rather than in the heater fleet.
 */
export type DeviceType = "heater" | "temphum";

/** Who owns a device's name: the board (sent in its frames) or an operator on the portal. */
export type NameSource = "device" | "portal";
export const NAME_SOURCES = ["device", "portal"] as const;

/** The model string the sensor board registers with. */
export const SENSOR_MODEL = "TEMP-HUM Ver1";
/** The `deviceType` the sensor board stamps on every telemetry frame. */
export const SENSOR_DEVICE_TYPE: DeviceType = "temphum";

/** True for the model the sensor board registers with, ignoring case and padding. */
export function isSensorModel(model: string | null | undefined): boolean {
  return model != null && model.trim().toLowerCase() === SENSOR_MODEL.toLowerCase();
}

/** Derived, not stored: a device is online when it was seen recently enough. */
export type DeviceStatus = "online" | "offline";

/**
 * Why a device is not reachable, derived from what we hold for it.
 * `never_seen` is a device that was provisioned but has never checked in.
 */
export type OfflineReason = "never_seen" | "silent";

// ------------------------------------------------------------------- channels

/** A physical output on the board: `device_channels` (channel_index 0-5). */
export interface ChannelConfig {
  channelIndex: number;
  channelId: string;
  name: string;
  kind: ChannelKind;
  relayPin: number | null;
  ctPin: number | null;
  calibration: number;
  enabled: boolean;
}

/** Per-channel measurements from one telemetry frame: `telemetry_channels`. */
export interface ChannelReading {
  channelIndex: number;
  channelId: string;
  isOn: boolean;
  currentA: number;
  powerW: number;
  energyWh: number;
  fault: FaultCode;
}

/** A channel's configuration joined to its most recent reading. */
export interface ChannelView extends ChannelConfig {
  reading: ChannelReading | null;
  /** Enabled, powered on, and the reading is live. */
  active: boolean;
}

// ------------------------------------------------------------------ telemetry

/**
 * One telemetry frame exactly as stored in `telemetry`. Timestamps are epoch
 * milliseconds on this side of the boundary; the database holds timestamptz.
 */
export interface TelemetryFrame {
  id: number;
  deviceId: string;
  recordedAt: number;

  // Heat control
  level: HeatLevel;
  levelValue: number;
  mode: string;
  manual: boolean;
  autoFan: boolean;
  tripped: boolean;

  // Climate (thermostat) control
  climate: boolean;
  climateTargetC: number | null;

  // Electrical
  totalCurrentA: number;
  sumCurrentA: number;
  totalPowerW: number;
  readingSource: string;
  meterVoltageV: number;
  mainsVoltageV: number;

  // Temperature: up to four probes plus a DHT sensor, and the firmware's own
  // average and max. The HEATER Ver1 board has three probes; the Fan Temp
  // Monitor has four and reports avgTempC.
  temp1C: number | null;
  temp2C: number | null;
  temp3C: number | null;
  temp4C: number | null;
  dhtTempC: number | null;
  /** Temperature from the second humidity sensor; only the sensor board has one. */
  dht2TempC: number | null;
  avgTempC: number | null;
  maxTempC: number | null;

  // Humidity probes
  humidity1Pct: number | null;
  humidity2Pct: number | null;
  humidity3Pct: number | null;

  /** How many of its sensors the board says are reading, or null if it does not say. */
  sensorsOk: number | null;
  /** The `deviceType` the frame carried, or null when the board sent none. */
  deviceType: string | null;

  // Protection limits in force at the time of the frame
  currentLimitA: number | null;
  totalLimitA: number | null;
  temperatureLimitC: number | null;

  // Connectivity as the hardware actually reports it
  wifi: WifiMode;
  ip: string | null;
  bluetoothClient: boolean;
  apiKeySet: boolean;
  /**
   * Measured Wi-Fi signal strength in dBm, or null when the firmware does not
   * report it. One value, matching the `telemetry.wifi_rssi_dbm` column;
   * never inferred, and never converted into a distance.
   */
  rssiDbm: number | null;
  /**
   * Measured RSSI of the connected Bluetooth peer in dBm, matching the
   * `telemetry.ble_rssi_dbm` column. Null when no peer is connected or the
   * firmware does not report it.
   */
  bleRssiDbm: number | null;

  uptimeSeconds: number;
  /** Untouched firmware payload, kept for forensics. */
  raw: Record<string, unknown> | null;

  channels: ChannelReading[];
}

// --------------------------------------------------------------------- device

/** Identity and placement: `devices` joined to `rooms` and `homes`. */
export interface DeviceRecord {
  id: string;
  homeId: string;
  roomId: string | null;
  name: string;
  bluetoothName: string;
  bluetoothAddress: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
  model: string;
  deviceType: DeviceType;
  nameSource: NameSource;
  homeSsid: string | null;
  localAddress: string | null;
  remoteAddress: string | null;
  deviceKeySetAt: number | null;
  lastSeenAt: number | null;
  latestTelemetryId: number | null;
  createdAt: number;
  updatedAt: number;

  roomName: string | null;
  roomIcon: string | null;
  homeName: string;
  homeTimezone: string;
}

/** Operator-configurable protection and climate limits: `device_settings`. */
export interface DeviceSettings {
  deviceId: string;
  currentLimitA: number;
  totalLimitA: number;
  temperatureLimitC: number;
  mainsVoltageV: number;
  autoFan: boolean;
  climateEnabled: boolean;
  climateTargetC: number;
  irSlots: unknown[];
  updatedAt: number;
}

/**
 * A device as the dashboard consumes it: the stored record, its newest
 * telemetry frame, its channels, and everything derived from the current clock.
 * Derivation happens on read, so a device is never "still online" merely
 * because it was online when the row was written.
 */
/**
 * Signal strength as the API reports it. `quality` is null whenever there is no
 * usable reading, and `reason` says why; a client must not render a bar in that
 * case. Mirrors GET /devices/{id}/signal one-for-one.
 */
export interface SignalInfo {
  rssiDbm: number | null;
  quality: SignalQuality | null;
  label: string | null;
  /** 0-4, for a meter. Zero whenever there is no reading. */
  bars: number;
  /** Linear across -100..-50 dBm. A display convenience; trust rssiDbm. */
  percent: number | null;
  reason: SignalReason | null;
}

export interface DeviceView {
  // Identity
  id: string;
  name: string;
  /** "device": follows the name the board sends; "portal": set by an operator. */
  nameSource: NameSource;
  model: string;
  deviceType: DeviceType;
  serialNumber: string | null;
  firmwareVersion: string | null;
  bluetoothName: string;
  bluetoothAddress: string | null;
  homeSsid: string | null;
  localAddress: string | null;
  remoteAddress: string | null;
  roomId: string | null;
  roomName: string | null;
  roomIcon: string | null;
  homeName: string;
  homeTimezone: string;
  createdAt: number;
  /**
   * The board has claimed this row and holds a device key. A device added on
   * the portal starts unpaired and cannot post telemetry until the board with
   * the matching serial checks in (see POST /api/devices/claim).
   */
  paired: boolean;
  pairedAt: number | null;

  // Liveness (derived)
  status: DeviceStatus;
  online: boolean;
  offlineReason: OfflineReason | null;
  lastSeenAt: number | null;
  /** Age of the newest frame in ms, or null if the device has never reported. */
  dataAgeMs: number | null;
  /** Old enough that it must not be presented as a live reading. */
  stale: boolean;

  /** Link quality of whichever transport is carrying the data (derived). */
  signal: SignalInfo;

  // Newest frame (null until the device first reports)
  telemetry: TelemetryFrame | null;
  channels: ChannelView[];
  settings: DeviceSettings | null;

  // Roll-ups derived from the newest frame
  /** Highest reading across the three probes and the DHT sensor. */
  hottestTempC: number | null;
  /** Mean of whichever humidity probes reported. */
  averageHumidityPct: number | null;
  /** Heat level above off, drawing current, and live. */
  heating: boolean;
  /** Any channel currently switched on. */
  anyChannelOn: boolean;
  /** Channels reporting anything other than `ok`. */
  faultCount: number;
  /** Open (uncleared) alerts. */
  openAlertCount: number;
  /** Highest severity among open alerts. */
  worstAlertSeverity: AlertSeverity | null;
  /** Protection trip is latched. */
  tripped: boolean;
}

/**
 * `device_claim_requests` - a board that presented a serial nobody has added
 * yet. Surfaced on the Add device form so the operator can adopt it in one
 * click instead of copying the serial off a serial monitor.
 */
export interface ClaimRequest {
  serialNumber: string;
  model: string | null;
  firmwareVersion: string | null;
  bluetoothName: string | null;
  homeSsid: string | null;
  localAddress: string | null;
  ip: string | null;
  attempts: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

// --------------------------------------------------------- alerts and commands

/** `alerts` - raised by the ingest layer against limits, cleared when resolved. */
export interface DeviceAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  channelIndex: number | null;
  channelId: string | null;
  code: string;
  severity: AlertSeverity;
  message: string;
  value: number | null;
  raisedAt: number;
  clearedAt: number | null;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

/** `commands` - queued by an operator, collected by the device. */
export interface DeviceCommand {
  id: string;
  deviceId: string;
  issuedBy: string | null;
  command: string;
  status: CommandStatus;
  reply: string | null;
  error: string | null;
  createdAt: number;
  deliveredAt: number | null;
  completedAt: number | null;
  expiresAt: number;
}

/** `audit_log` - who changed what, and from where. */
export interface AuditEntry {
  id: number;
  userId: string | null;
  userName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: number;
}

/** `energy_hourly` - a per-channel hourly rollup. */
export interface EnergyBucket {
  deviceId: string;
  channelIndex: number;
  channelId: string;
  bucket: number;
  energyWh: number;
  avgPowerW: number;
  peakPowerW: number;
  onSamples: number;
  samples: number;
}

// ---------------------------------------------------------------- fleet stats

/** Fleet-wide counters for the overview summary strip. */
export interface FleetStats {
  total: number;
  online: number;
  offline: number;
  neverSeen: number;
  stale: number;
  /** Devices with heat level above off. */
  heating: number;
  /** Devices with a latched protection trip. */
  tripped: number;
  /** Devices running in climate (thermostat) mode. */
  climate: number;
  /** Devices joined to home Wi-Fi vs. serving their own access point. */
  wifiSta: number;
  wifiAp: number;
  /** Devices with a Bluetooth client currently attached. */
  bluetoothClients: number;
  /** Channels currently switched on, across the fleet. */
  channelsOn: number;
  channelsTotal: number;
  channelFaults: number;
  openAlerts: number;
  criticalAlerts: number;
  pendingCommands: number;
  /** Instantaneous fleet draw, summed across online devices. */
  totalPowerW: number;
  totalCurrentA: number;
  /** Mean of every device's hottest probe. */
  averageTempC: number | null;
  hottestTempC: number | null;
  averageHumidityPct: number | null;
  levels: Record<HeatLevel, number>;
  faults: Record<FaultCode, number>;
  generatedAt: number;
}

// ------------------------------------------------------------------ streaming

export type StreamReason =
  | "telemetry"
  | "registered"
  | "updated"
  | "went_offline"
  | "came_online"
  | "command"
  | "settings";

/** Push payloads sent to the dashboard over SSE. */
export type StreamMessage =
  | { kind: "snapshot"; devices: DeviceView[]; stats: FleetStats; t: number }
  | { kind: "device"; reason: StreamReason; device: DeviceView; t: number }
  | { kind: "device_removed"; deviceId: string; t: number }
  | { kind: "alert"; alert: DeviceAlert; t: number }
  | { kind: "stats"; stats: FleetStats; t: number };

// ------------------------------------------------------------------ firmware

/**
 * Lifecycle of an uploaded image. `draft` is visible only in the portal;
 * `published` can be fetched by devices; `current` is the one published
 * release per model that the fleet is expected to run.
 */
export type FirmwareStatus = "draft" | "published" | "current";

/** `firmware_releases` without the image bytes. */
export interface FirmwareRelease {
  id: string;
  model: string;
  version: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  status: FirmwareStatus;
  isCurrent: boolean;
  publishedAt: number | null;
  uploadedBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Devices of this model currently reporting exactly this version. */
  deviceCount: number;
}
