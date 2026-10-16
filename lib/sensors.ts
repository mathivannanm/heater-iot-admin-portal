import { config } from "./config";
import { ms, msRequired, num, query, queryOne, text } from "./db";
import { deriveLiveness, deriveSignal } from "./status";
import { SENSOR_DEVICE_TYPE, SENSOR_MODEL } from "./types";
import type { WifiMode } from "./types";
import {
  DEFAULT_SENSOR_LABEL,
  HUMIDITY_SENSORS,
  SENSORS_TOTAL,
  SENSOR_KEYS,
  SERIES_FIELDS,
  TEMP_SENSORS,
  type SensorAlert,
  type SensorAlertKind,
  type SensorDevice,
  type SensorHistory,
  type SensorKey,
  type SensorPoint,
  type SensorReading,
  type SensorSettings,
  type SeriesField,
  type SeriesStats,
} from "./sensor-types";

/**
 * The temperature / humidity sensor repository.
 *
 * A TEMP-HUM Ver1 board registers and posts telemetry through the same two
 * endpoints as a heater, so its frames live in `telemetry` alongside everyone
 * else's. This module is the read side for the sensor pages - which devices are
 * sensors, what they last said, their history - plus the two things only a
 * sensor has: its thresholds and labels (`sensor_settings`) and the alerts
 * those thresholds raise (`sensor_alerts`).
 *
 * It deliberately imports nothing from `store.ts`, because the ingest path in
 * there calls `evaluateSensorAlerts` and the two must not depend on each other.
 */

export * from "./sensor-types";

const SERIES_COLUMN: Record<SeriesField, string> = {
  temp1C: "temp_1_c",
  temp2C: "temp_2_c",
  temp3C: "temp_3_c",
  temp4C: "temp_4_c",
  humidity1Pct: "humidity_1_pct",
  humidity2Pct: "humidity_2_pct",
  dhtTempC: "dht_temp_c",
  dht2TempC: "dht_2_temp_c",
};

// -------------------------------------------------------------------- helpers

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one definition of "this row is a sensor board", shared by every query. */
const IS_SENSOR = `(d.device_type = '${SENSOR_DEVICE_TYPE}' OR lower(btrim(d.model)) = '${SENSOR_MODEL.toLowerCase()}')`;

interface SensorRow {
  id: string;
  name: string;
  model: string;
  serial_number: string | null;
  firmware_version: string | null;
  home_ssid: string | null;
  local_address: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  device_key_set_at: Date | null;

  telemetry_id: number | null;
  recorded_at: Date | null;
  temp_1_c: number | null;
  temp_2_c: number | null;
  temp_3_c: number | null;
  temp_4_c: number | null;
  humidity_1_pct: number | null;
  humidity_2_pct: number | null;
  dht_temp_c: number | null;
  dht_2_temp_c: number | null;
  max_temp_c: number | null;
  sensors_ok: number | null;
  wifi: WifiMode | null;
  ip: string | null;
  wifi_rssi_dbm: number | null;
  uptime_seconds: number | null;

  temp_high_c: number | null;
  temp_low_c: number | null;
  humidity_high_pct: number | null;
  humidity_low_pct: number | null;
  labels: unknown;
  settings_updated_at: Date | null;

  open_alerts: number;
}

const SENSOR_SELECT = `
  SELECT d.id, d.name, d.model, d.serial_number, d.firmware_version, d.home_ssid,
         d.local_address, d.created_at, d.last_seen_at, d.device_key_set_at,
         t.id AS telemetry_id, t.recorded_at,
         t.temp_1_c, t.temp_2_c, t.temp_3_c, t.temp_4_c,
         t.humidity_1_pct, t.humidity_2_pct, t.dht_temp_c, t.dht_2_temp_c,
         t.max_temp_c, t.sensors_ok, t.wifi, t.ip, t.wifi_rssi_dbm, t.uptime_seconds,
         s.temp_high_c, s.temp_low_c, s.humidity_high_pct, s.humidity_low_pct,
         s.labels, s.updated_at AS settings_updated_at,
         (SELECT count(*)::int FROM sensor_alerts a
           WHERE a.device_id = d.id AND a.cleared_at IS NULL) AS open_alerts
  FROM devices d
  LEFT JOIN telemetry t ON t.id = d.latest_telemetry_id
  LEFT JOIN sensor_settings s ON s.device_id = d.id
`;

function mapLabels(value: unknown): Partial<Record<SensorKey, string>> {
  const labels: Partial<Record<SensorKey, string>> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return labels;
  for (const key of SENSOR_KEYS) {
    const label = (value as Record<string, unknown>)[key];
    if (typeof label === "string" && label.trim() !== "") labels[key] = label.trim();
  }
  return labels;
}

function mapSettings(row: {
  temp_high_c: number | null;
  temp_low_c: number | null;
  humidity_high_pct: number | null;
  humidity_low_pct: number | null;
  labels: unknown;
  settings_updated_at: Date | null;
}): SensorSettings {
  return {
    tempHighC: num(row.temp_high_c),
    tempLowC: num(row.temp_low_c),
    humidityHighPct: num(row.humidity_high_pct),
    humidityLowPct: num(row.humidity_low_pct),
    labels: mapLabels(row.labels),
    updatedAt: ms(row.settings_updated_at),
  };
}

function mapReading(row: SensorRow): SensorReading | null {
  if (row.telemetry_id === null || row.recorded_at === null) return null;

  const temps = [row.temp_1_c, row.temp_2_c, row.temp_3_c, row.temp_4_c].map(num);
  const humidities = [row.humidity_1_pct, row.humidity_2_pct].map(num);
  const reading = [...temps, ...humidities].filter((value) => value !== null).length;
  const probes = temps.filter((value): value is number => value !== null);

  return {
    telemetryId: row.telemetry_id,
    recordedAt: msRequired(row.recorded_at),
    temp1C: temps[0],
    temp2C: temps[1],
    temp3C: temps[2],
    temp4C: temps[3],
    humidity1Pct: humidities[0],
    humidity2Pct: humidities[1],
    dhtTempC: num(row.dht_temp_c),
    dht2TempC: num(row.dht_2_temp_c),
    maxTempC: num(row.max_temp_c) ?? (probes.length > 0 ? Math.max(...probes) : null),
    sensorsOk: row.sensors_ok ?? reading,
    sensorsTotal: SENSORS_TOTAL,
    wifi: row.wifi ?? "STA",
    ip: text(row.ip),
    rssiDbm: num(row.wifi_rssi_dbm),
    uptimeSeconds: row.uptime_seconds ?? 0,
  };
}

function mapSensor(row: SensorRow, now: number): SensorDevice {
  const lastSeenAt = ms(row.last_seen_at);
  const liveness = deriveLiveness(lastSeenAt, now, config.sensor.offlineTimeoutMs);
  const latest = mapReading(row);

  return {
    id: row.id,
    name: row.name,
    model: row.model,
    serialNumber: text(row.serial_number),
    firmwareVersion: text(row.firmware_version),
    homeSsid: text(row.home_ssid),
    localAddress: text(row.local_address),
    createdAt: msRequired(row.created_at),
    paired: row.device_key_set_at !== null,

    status: liveness.status,
    online: liveness.online,
    lastSeenAt,
    dataAgeMs: liveness.dataAgeMs,
    signal: deriveSignal(latest, liveness.online),

    latest,
    settings: mapSettings(row),
    openAlertCount: row.open_alerts,
  };
}

// ---------------------------------------------------------------------- reads

export async function listSensors(now: number = Date.now()): Promise<SensorDevice[]> {
  const rows = await query<SensorRow>(`${SENSOR_SELECT} WHERE ${IS_SENSOR} ORDER BY d.name, d.id`);
  return rows.map((row) => mapSensor(row, now));
}

/** One sensor board, or null when the id is unknown or belongs to a heater. */
export async function getSensor(
  deviceId: string,
  now: number = Date.now(),
): Promise<SensorDevice | null> {
  if (!UUID.test(deviceId)) return null;
  const row = await queryOne<SensorRow>(`${SENSOR_SELECT} WHERE d.id = $1 AND ${IS_SENSOR}`, [
    deviceId,
  ]);
  return row ? mapSensor(row, now) : null;
}

/** Whether `deviceId` is a sensor board, without loading its reading. */
export async function isSensorDevice(deviceId: string): Promise<boolean> {
  if (!UUID.test(deviceId)) return false;
  const row = await queryOne(`SELECT 1 FROM devices d WHERE d.id = $1 AND ${IS_SENSOR}`, [deviceId]);
  return row !== null;
}

// -------------------------------------------------------------------- history

const SERIES_SELECT = SERIES_FIELDS.map((field) => SERIES_COLUMN[field]).join(", ");

type SeriesRow = { recorded_at: Date } & Record<string, number | null>;

function mapPoint(row: SeriesRow): SensorPoint {
  const point = { t: msRequired(row.recorded_at) } as SensorPoint;
  for (const field of SERIES_FIELDS) point[field] = num(row[SERIES_COLUMN[field]]);
  return point;
}

/**
 * A window of sensor history: the series thinned to at most `maxPoints` for
 * the charts, and min / max / average per sensor over every stored frame.
 *
 * Thinning keeps real readings rather than averaging buckets, the same way the
 * heater history does, and a null stays a null: a sensor that was not reading
 * is a gap on the chart and is left out of the statistics, never counted as 0.
 */
export async function getSensorHistory(
  deviceId: string,
  from: number,
  to: number,
  maxPoints: number = config.history.maxSamples,
): Promise<SensorHistory> {
  const empty: SensorHistory = {
    from,
    to,
    totalRows: 0,
    points: [],
    stats: Object.fromEntries(
      SERIES_FIELDS.map((field) => [field, { min: null, max: null, avg: null, count: 0 }]),
    ) as Record<SeriesField, SeriesStats>,
  };
  if (!UUID.test(deviceId)) return empty;

  const window = [deviceId, new Date(from), new Date(to)];

  const aggregates = SERIES_FIELDS.flatMap((field) => {
    const column = SERIES_COLUMN[field];
    return [
      `min(${column}) AS ${column}_min`,
      `max(${column}) AS ${column}_max`,
      `avg(${column}) AS ${column}_avg`,
      `count(${column})::int AS ${column}_count`,
    ];
  }).join(", ");

  const [rows, summary] = await Promise.all([
    query<SeriesRow>(
      `WITH windowed AS (
         SELECT recorded_at, ${SERIES_SELECT},
                count(*) OVER () AS total_rows,
                row_number() OVER (ORDER BY recorded_at) AS rn
         FROM telemetry
         WHERE device_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
       )
       SELECT recorded_at, ${SERIES_SELECT} FROM windowed
       WHERE rn % GREATEST(1, ceil(total_rows::numeric / $4)::int) = 0 OR rn = 1 OR rn = total_rows
       ORDER BY recorded_at`,
      [...window, Math.max(1, maxPoints)],
    ),
    queryOne<Record<string, number | null>>(
      `SELECT count(*)::int AS total_rows, ${aggregates}
       FROM telemetry
       WHERE device_id = $1 AND recorded_at >= $2 AND recorded_at <= $3`,
      window,
    ),
  ]);

  const stats = { ...empty.stats };
  for (const field of SERIES_FIELDS) {
    const column = SERIES_COLUMN[field];
    stats[field] = {
      min: num(summary?.[`${column}_min`]),
      max: num(summary?.[`${column}_max`]),
      avg: num(summary?.[`${column}_avg`]),
      count: summary?.[`${column}_count`] ?? 0,
    };
  }

  return {
    from,
    to,
    totalRows: summary?.total_rows ?? 0,
    points: rows.map(mapPoint),
    stats,
  };
}

// ------------------------------------------------------------------------ csv

/** Most rows a single export will carry; seven days at one frame per 5 s is ~121k. */
const CSV_MAX_ROWS = 250_000;

const CSV_COLUMNS = [
  "time_utc",
  "epoch_ms",
  ...SERIES_FIELDS,
  "maxTempC",
  "sensorsOk",
  "rssiDbm",
] as const;

/** Quotes a cell only when it has to be, and doubles any quote inside it. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const cell = String(value);
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * Every stored frame in the window as CSV, oldest first and not thinned.
 *
 * A sensor that was not reading is an empty cell, never a zero, so a
 * spreadsheet average over the column comes out the same as the one on the
 * page. Timestamps are UTC in ISO 8601, with the epoch alongside for scripts.
 */
export async function exportSensorCsv(
  deviceId: string,
  from: number,
  to: number,
): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const header = CSV_COLUMNS.join(",");
  if (!UUID.test(deviceId)) return { csv: `${header}\r\n`, rows: 0, truncated: false };

  const rows = await query<SeriesRow>(
    `SELECT recorded_at, ${SERIES_SELECT}, max_temp_c, sensors_ok, wifi_rssi_dbm
     FROM telemetry
     WHERE device_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
     ORDER BY recorded_at
     LIMIT $4`,
    [deviceId, new Date(from), new Date(to), CSV_MAX_ROWS + 1],
  );

  const truncated = rows.length > CSV_MAX_ROWS;
  const kept = truncated ? rows.slice(0, CSV_MAX_ROWS) : rows;

  const lines = kept.map((row) => {
    const t = msRequired(row.recorded_at);
    return [
      new Date(t).toISOString(),
      t,
      ...SERIES_FIELDS.map((field) => num(row[SERIES_COLUMN[field]])),
      num(row.max_temp_c),
      num(row.sensors_ok),
      num(row.wifi_rssi_dbm),
    ]
      .map(csvCell)
      .join(",");
  });

  return { csv: [header, ...lines].join("\r\n") + "\r\n", rows: kept.length, truncated };
}

// ------------------------------------------------------------------- settings

export interface SensorSettingsPatch {
  tempHighC?: number | null;
  tempLowC?: number | null;
  humidityHighPct?: number | null;
  humidityLowPct?: number | null;
  /** A sensor mapped to null or "" goes back to its default name. */
  labels?: Partial<Record<SensorKey, string | null>>;
}

export class SensorSettingsError extends Error {}

const EMPTY_SETTINGS: SensorSettings = {
  tempHighC: null,
  tempLowC: null,
  humidityHighPct: null,
  humidityLowPct: null,
  labels: {},
  updatedAt: null,
};

async function readSettings(deviceId: string): Promise<SensorSettings> {
  const row = await queryOne<{
    temp_high_c: number | null;
    temp_low_c: number | null;
    humidity_high_pct: number | null;
    humidity_low_pct: number | null;
    labels: unknown;
    settings_updated_at: Date | null;
  }>(
    `SELECT temp_high_c, temp_low_c, humidity_high_pct, humidity_low_pct, labels,
            updated_at AS settings_updated_at
     FROM sensor_settings WHERE device_id = $1`,
    [deviceId],
  );
  return row ? mapSettings(row) : EMPTY_SETTINGS;
}

/**
 * Applies a patch to a sensor's thresholds and labels and re-measures the
 * newest reading against the result, so an alert that a relaxed limit no
 * longer justifies clears now instead of waiting for the next frame.
 */
export async function updateSensorSettings(
  deviceId: string,
  patch: SensorSettingsPatch,
  now: number = Date.now(),
): Promise<SensorSettings | null> {
  const sensor = await getSensor(deviceId, now);
  if (!sensor) return null;

  const current = sensor.settings;
  const pick = (next: number | null | undefined, previous: number | null) =>
    next === undefined ? previous : next;

  const next = {
    tempHighC: pick(patch.tempHighC, current.tempHighC),
    tempLowC: pick(patch.tempLowC, current.tempLowC),
    humidityHighPct: pick(patch.humidityHighPct, current.humidityHighPct),
    humidityLowPct: pick(patch.humidityLowPct, current.humidityLowPct),
  };

  if (next.tempHighC !== null && next.tempLowC !== null && next.tempLowC >= next.tempHighC) {
    throw new SensorSettingsError("The low temperature limit must be below the high limit");
  }
  if (
    next.humidityHighPct !== null &&
    next.humidityLowPct !== null &&
    next.humidityLowPct >= next.humidityHighPct
  ) {
    throw new SensorSettingsError("The low humidity limit must be below the high limit");
  }

  const labels: Partial<Record<SensorKey, string>> = { ...current.labels };
  for (const key of SENSOR_KEYS) {
    if (!patch.labels || !(key in patch.labels)) continue;
    const label = patch.labels[key]?.trim() ?? "";
    if (label === "" || label === DEFAULT_SENSOR_LABEL[key]) delete labels[key];
    else labels[key] = label;
  }

  await query(
    `INSERT INTO sensor_settings (
       device_id, temp_high_c, temp_low_c, humidity_high_pct, humidity_low_pct, labels
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (device_id) DO UPDATE SET
       temp_high_c = EXCLUDED.temp_high_c,
       temp_low_c = EXCLUDED.temp_low_c,
       humidity_high_pct = EXCLUDED.humidity_high_pct,
       humidity_low_pct = EXCLUDED.humidity_low_pct,
       labels = EXCLUDED.labels,
       updated_at = now()`,
    [
      deviceId,
      next.tempHighC,
      next.tempLowC,
      next.humidityHighPct,
      next.humidityLowPct,
      JSON.stringify(labels),
    ],
  );

  if (sensor.latest) {
    await evaluateSensorAlerts(
      deviceId,
      {
        t1: sensor.latest.temp1C,
        t2: sensor.latest.temp2C,
        t3: sensor.latest.temp3C,
        t4: sensor.latest.temp4C,
        h1: sensor.latest.humidity1Pct,
        h2: sensor.latest.humidity2Pct,
      },
      // The last reading of a board that has gone quiet is history: it may
      // clear an alert, but it must not raise one dated now.
      { raise: sensor.online },
    );
  }

  return readSettings(deviceId);
}

// --------------------------------------------------------------------- alerts

interface SensorAlertRow {
  id: string;
  device_id: string;
  sensor: SensorKey;
  kind: SensorAlertKind;
  message: string;
  value: number | null;
  threshold: number | null;
  raised_at: Date;
  cleared_at: Date | null;
}

function mapAlert(row: SensorAlertRow): SensorAlert {
  return {
    id: row.id,
    deviceId: row.device_id,
    sensor: row.sensor,
    kind: row.kind,
    message: row.message,
    value: num(row.value),
    threshold: num(row.threshold),
    raisedAt: msRequired(row.raised_at),
    clearedAt: ms(row.cleared_at),
  };
}

/** Alerts for one sensor board: whatever is still open first, then newest. */
export async function listSensorAlerts(
  deviceId: string,
  options: { open?: boolean; limit?: number } = {},
): Promise<SensorAlert[]> {
  if (!UUID.test(deviceId)) return [];

  const conditions = ["device_id = $1"];
  if (options.open === true) conditions.push("cleared_at IS NULL");
  if (options.open === false) conditions.push("cleared_at IS NOT NULL");

  const rows = await query<SensorAlertRow>(
    `SELECT * FROM sensor_alerts
     WHERE ${conditions.join(" AND ")}
     ORDER BY (cleared_at IS NULL) DESC, raised_at DESC
     LIMIT $2`,
    [deviceId, Math.min(Math.max(options.limit ?? 100, 1), config.history.maxAlerts)],
  );
  return rows.map(mapAlert);
}

/**
 * Raises and clears threshold alerts from one set of readings.
 *
 * Raising is idempotent: the partial unique index on (device, sensor, kind)
 * where `cleared_at IS NULL` means a reading that stays out of range for an
 * hour is one alert, whose `raised_at` is when it started. Anything open that
 * these readings do not re-assert has resolved and is cleared - including a
 * sensor that has stopped reading, because a missing value is not a breach.
 */
export async function evaluateSensorAlerts(
  deviceId: string,
  values: Record<SensorKey, number | null>,
  options: { raise?: boolean } = {},
): Promise<void> {
  if (!UUID.test(deviceId)) return;
  const settings = await readSettings(deviceId);

  const breaches: Array<{
    sensor: SensorKey;
    kind: SensorAlertKind;
    value: number;
    threshold: number;
    message: string;
  }> = [];

  const name = (sensor: SensorKey) => {
    const label = settings.labels[sensor];
    return label ? `${DEFAULT_SENSOR_LABEL[sensor]} (${label})` : DEFAULT_SENSOR_LABEL[sensor];
  };

  const check = (
    sensor: SensorKey,
    unit: string,
    high: number | null,
    low: number | null,
    kinds: { high: SensorAlertKind; low: SensorAlertKind },
  ) => {
    const value = values[sensor];
    if (value === null) return;
    if (high !== null && value > high) {
      breaches.push({
        sensor,
        kind: kinds.high,
        value,
        threshold: high,
        message: `${name(sensor)} ${value.toFixed(1)}${unit} is above the ${high.toFixed(1)}${unit} limit`,
      });
    } else if (low !== null && value < low) {
      breaches.push({
        sensor,
        kind: kinds.low,
        value,
        threshold: low,
        message: `${name(sensor)} ${value.toFixed(1)}${unit} is below the ${low.toFixed(1)}${unit} limit`,
      });
    }
  };

  for (const sensor of TEMP_SENSORS) {
    check(sensor, "°C", settings.tempHighC, settings.tempLowC, {
      high: "temp_high",
      low: "temp_low",
    });
  }
  for (const sensor of HUMIDITY_SENSORS) {
    check(sensor, "%", settings.humidityHighPct, settings.humidityLowPct, {
      high: "humidity_high",
      low: "humidity_low",
    });
  }

  if (options.raise !== false) {
    for (const breach of breaches) {
      await query(
        `INSERT INTO sensor_alerts (device_id, sensor, kind, message, value, threshold)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (device_id, sensor, kind) WHERE cleared_at IS NULL DO NOTHING`,
        [deviceId, breach.sensor, breach.kind, breach.message, breach.value, breach.threshold],
      );
    }
  }

  const stillOpen = breaches.map((breach) => `${breach.sensor}:${breach.kind}`);
  await query(
    `UPDATE sensor_alerts SET cleared_at = now()
     WHERE device_id = $1 AND cleared_at IS NULL
       AND (sensor || ':' || kind) <> ALL($2)`,
    [deviceId, stillOpen.length > 0 ? stillOpen : [""]],
  );
}
