/**
 * Runtime configuration for the HEATER Ver1 monitoring backend.
 *
 * Everything is environment-driven. Note what is *not* here: any notion of
 * distance. Signal strength is bucketed from the RSSI the firmware actually
 * measures; usable range depends on the antenna, the enclosure, obstacles and
 * the peer's own radio, so no metre threshold is defined anywhere.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

export const config = {
  /**
   * Liveness. The firmware posts telemetry every `telemetryIntervalMs`; a
   * device is marked offline once `devices.last_seen_at` is older than
   * `offlineTimeoutMs`. The timeout is a small multiple of the interval so a
   * couple of dropped frames do not flap the status.
   */
  telemetryIntervalMs: num("HEATER_TELEMETRY_INTERVAL_MS", 15_000),
  offlineTimeoutMs: num("HEATER_OFFLINE_TIMEOUT_MS", 45_000),

  /** Frames older than this keep their values but are flagged "not live". */
  staleDataMs: num("HEATER_STALE_DATA_MS", 20_000),

  /**
   * Temperature / humidity sensor boards (TEMP-HUM Ver1). They post on the
   * same interval as a heater but are judged against their own timeout: a
   * sensor is online while its last frame is at most this old.
   */
  sensor: {
    offlineTimeoutMs: num("HEATER_SENSOR_OFFLINE_TIMEOUT_MS", 60_000),
  },

  /** How often the server re-evaluates every device's online/offline status. */
  sweepIntervalMs: num("HEATER_SWEEP_INTERVAL_MS", 5_000),

  /**
   * RSSI (dBm) bands used to label a link Excellent / Good / Weak. Wi-Fi and
   * Bluetooth radios have different usable floors, so each is tuned
   * separately. Tune these to the hardware in the field rather than treating
   * them as universal constants.
   */
  wifiRssi: {
    excellent: num("HEATER_WIFI_RSSI_EXCELLENT", -55),
    good: num("HEATER_WIFI_RSSI_GOOD", -67),
    floor: num("HEATER_WIFI_RSSI_FLOOR", -95),
  },
  bleRssi: {
    excellent: num("HEATER_BLE_RSSI_EXCELLENT", -60),
    good: num("HEATER_BLE_RSSI_GOOD", -75),
    floor: num("HEATER_BLE_RSSI_FLOOR", -100),
  },

  /**
   * Safety limits used when a device has no row in `device_settings`. These
   * mirror the column defaults in the schema so the dashboard and the database
   * cannot disagree about what protection is in force.
   */
  defaults: {
    currentLimitA: num("HEATER_DEFAULT_CURRENT_LIMIT_A", 12),
    totalLimitA: num("HEATER_DEFAULT_TOTAL_LIMIT_A", 30),
    temperatureLimitC: num("HEATER_DEFAULT_TEMPERATURE_LIMIT_C", 85),
    mainsVoltageV: num("HEATER_DEFAULT_MAINS_VOLTAGE_V", 230),
    climateTargetC: num("HEATER_DEFAULT_CLIMATE_TARGET_C", 21),
  },

  /**
   * Fractions of the configured limits at which a warning alert is raised,
   * before the hardware itself trips. 0.9 = warn at 90% of the limit.
   */
  warnAtFractionOfLimit: num("HEATER_WARN_FRACTION", 0.9),

  /** History query guards, so one wide range cannot pull a million rows. */
  history: {
    maxSamples: num("HEATER_HISTORY_MAX_SAMPLES", 2_000),
    maxEvents: num("HEATER_HISTORY_MAX_EVENTS", 500),
    maxAlerts: num("HEATER_HISTORY_MAX_ALERTS", 200),
    maxCommands: num("HEATER_HISTORY_MAX_COMMANDS", 200),
    /** Telemetry older than this is pruned by the sweeper. */
    retentionMs: num("HEATER_HISTORY_RETENTION_MS", 30 * 24 * 60 * 60 * 1000),
  },

  /**
   * Request log for every /api call, written to `api_requests` and echoed to
   * the server console. On by default so "is the board calling us?" can be
   * answered from the database; HEATER_API_LOG=off silences both.
   */
  apiLog: {
    enabled: bool("HEATER_API_LOG", true),
    console: bool("HEATER_API_LOG_CONSOLE", true),
    /** Rows older than this are pruned lazily, at most once an hour. */
    retentionMs: num("HEATER_API_LOG_RETENTION_MS", 7 * 24 * 60 * 60 * 1000),
  },

  /** Server-Sent Events keep-alive comment interval. */
  sseKeepAliveMs: num("HEATER_SSE_KEEPALIVE_MS", 20_000),

  /**
   * Origins allowed to call /api from a browser (CORS). `*` allows every
   * origin, which is the default so a web build of the mobile app or any
   * external dashboard can call the API. A comma-separated list restricts it;
   * then the matching origin is echoed back and credentials are allowed.
   */
  corsOrigins: (process.env.HEATER_CORS_ORIGINS ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  /** Secret the firmware presents on ingest. Unset = open (development only). */
  provisioningKey: process.env.HEATER_PROVISIONING_KEY ?? "",
  /** Secret required by the admin/dashboard APIs. Unset = open (development only). */
  adminKey: process.env.HEATER_ADMIN_KEY ?? "",
  /**
   * Secret the mobile app presents to the firmware-update endpoints. Unset =
   * open, which is acceptable for version metadata but should be set before
   * images are served to the internet.
   */
  appKey: process.env.HEATER_APP_KEY ?? "",

  simulator: {
    /**
     * A virtual HEATER Ver1 that drives the real ingest endpoint, so the
     * dashboard has live data before hardware is on the bench. It writes
     * through the API into Postgres exactly as firmware would - it is not a
     * UI mock. Off by default so the portal only ever shows what real devices
     * report; opt in with HEATER_SIM=on for a demo or UI work.
     */
    enabled: bool("HEATER_SIM", false),
    /** Extra virtual devices to provision beyond those already in the database. */
    extraDevices: num("HEATER_SIM_EXTRA_DEVICES", 5),
    tickMs: num("HEATER_SIM_TICK_MS", 5_000),
  },
} as const;

/**
 * IANA timezone for every absolute timestamp on screen. Fixed rather than taken
 * from the browser so the server and the client render the same string, which
 * is what keeps hydration clean when the server runs in a different zone from
 * the viewer. Defaults to the seeded home's zone.
 */
export const displayTimezone =
  process.env.NEXT_PUBLIC_HEATER_TIMEZONE && process.env.NEXT_PUBLIC_HEATER_TIMEZONE !== ""
    ? process.env.NEXT_PUBLIC_HEATER_TIMEZONE
    : "Asia/Kolkata";

export type HeaterConfig = typeof config;
