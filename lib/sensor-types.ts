import type { DeviceStatus, SignalInfo, WifiMode } from "./types";

/**
 * The sensor board's vocabulary and wire types.
 *
 * Kept free of anything server-side so the pages' client components can import
 * the names, labels and ranges at runtime; `lib/sensors.ts` re-exports all of
 * it next to the queries.
 */

// ------------------------------------------------------------------ vocabulary

export const TEMP_SENSORS = ["t1", "t2", "t3", "t4"] as const;
export const HUMIDITY_SENSORS = ["h1", "h2"] as const;
export const SENSOR_KEYS = [...TEMP_SENSORS, ...HUMIDITY_SENSORS] as const;

export type SensorKey = (typeof SENSOR_KEYS)[number];
export type SensorAlertKind = "temp_high" | "temp_low" | "humidity_high" | "humidity_low";

/** How many sensors the board carries: four probes and two humidity sensors. */
export const SENSORS_TOTAL = SENSOR_KEYS.length;

/** The name a sensor goes by until the operator gives it one. */
export const DEFAULT_SENSOR_LABEL: Record<SensorKey, string> = {
  t1: "T1",
  t2: "T2",
  t3: "T3",
  t4: "T4",
  h1: "H1",
  h2: "H2",
};

export const SENSOR_LABEL_MAX_LENGTH = 40;

/**
 * The eight values a sensor board reports, under the names the firmware sends
 * them by. `dhtTempC` and `dht2TempC` are the temperatures measured by the two
 * humidity sensors themselves.
 */
export const SERIES_FIELDS = [
  "temp1C",
  "temp2C",
  "temp3C",
  "temp4C",
  "humidity1Pct",
  "humidity2Pct",
  "dhtTempC",
  "dht2TempC",
] as const;

export type SeriesField = (typeof SERIES_FIELDS)[number];

export const SENSOR_RANGES = ["1h", "6h", "24h", "7d"] as const;
export type SensorRange = (typeof SENSOR_RANGES)[number];

const RANGE_MS: Record<SensorRange, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function isSensorRange(value: string): value is SensorRange {
  return (SENSOR_RANGES as readonly string[]).includes(value);
}

export function resolveSensorRange(
  range: SensorRange,
  now: number = Date.now(),
): { from: number; to: number } {
  return { from: now - RANGE_MS[range], to: now };
}

// ---------------------------------------------------------------------- types

export interface SensorSettings {
  /** Null means no limit is set, which is not the same as a limit of zero. */
  tempHighC: number | null;
  tempLowC: number | null;
  humidityHighPct: number | null;
  humidityLowPct: number | null;
  /** Only the sensors the operator has named; the rest use their default. */
  labels: Partial<Record<SensorKey, string>>;
  updatedAt: number | null;
}

/** The newest frame from a sensor board. Null is a sensor that is not reading. */
export interface SensorReading {
  telemetryId: number;
  recordedAt: number;
  temp1C: number | null;
  temp2C: number | null;
  temp3C: number | null;
  temp4C: number | null;
  humidity1Pct: number | null;
  humidity2Pct: number | null;
  dhtTempC: number | null;
  dht2TempC: number | null;
  /** As the board reported it, or the highest probe when it did not. */
  maxTempC: number | null;
  /** As the board reported it, or a count of the sensors that are reading. */
  sensorsOk: number;
  sensorsTotal: number;
  wifi: WifiMode;
  ip: string | null;
  rssiDbm: number | null;
  uptimeSeconds: number;
}

export interface SensorDevice {
  id: string;
  name: string;
  model: string;
  serialNumber: string | null;
  firmwareVersion: string | null;
  homeSsid: string | null;
  localAddress: string | null;
  createdAt: number;
  /** The board holds a device key, so it is able to post telemetry. */
  paired: boolean;

  status: DeviceStatus;
  online: boolean;
  lastSeenAt: number | null;
  /** Age of the newest frame in ms, or null if the board has never reported. */
  dataAgeMs: number | null;
  signal: SignalInfo;

  latest: SensorReading | null;
  settings: SensorSettings;
  openAlertCount: number;
}

export interface SensorAlert {
  id: string;
  deviceId: string;
  sensor: SensorKey;
  kind: SensorAlertKind;
  message: string;
  value: number | null;
  threshold: number | null;
  raisedAt: number;
  clearedAt: number | null;
}

export type SensorPoint = { t: number } & Record<SeriesField, number | null>;

export interface SeriesStats {
  min: number | null;
  max: number | null;
  avg: number | null;
  /** Frames in the window in which this sensor was actually reading. */
  count: number;
}

export interface SensorHistory {
  from: number;
  to: number;
  /** Every frame stored in the window, before thinning for the chart. */
  totalRows: number;
  points: SensorPoint[];
  /** Computed over every stored frame, not over the thinned points. */
  stats: Record<SeriesField, SeriesStats>;
}
