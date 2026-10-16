import { config } from "./config";
import { SIGNAL_LABEL } from "./format";

/**
 * The HeaterFan API's signal bands (see its §9b and GET /meta), ordered
 * strongest first. Duplicated here only for the direct-database path; the API
 * response already carries the band it chose.
 */
const SIGNAL_BANDS: ReadonlyArray<{ min: number; quality: SignalQuality; bars: number }> = [
  { min: -55, quality: "excellent", bars: 4 },
  { min: -66, quality: "good", bars: 3 },
  { min: -77, quality: "fair", bars: 2 },
  { min: -89, quality: "weak", bars: 1 },
  { min: -Infinity, quality: "unusable", bars: 0 },
];
import type {
  AlertSeverity,
  ChannelConfig,
  ChannelView,
  DeviceRecord,
  DeviceSettings,
  DeviceStatus,
  DeviceView,
  FaultCode,
  FleetStats,
  HeatLevel,
  SignalInfo,
  SignalQuality,
  OfflineReason,
  TelemetryFrame,
} from "./types";

/**
 * Everything the dashboard shows that is not literally a column.
 *
 * Liveness is derived on read from `devices.last_seen_at` against the current
 * clock, never stored as a flag. A stored flag goes stale the moment a device
 * stops talking - the row would still say "online" because nothing wrote to it.
 */

export interface Liveness {
  status: DeviceStatus;
  online: boolean;
  offlineReason: OfflineReason | null;
  dataAgeMs: number | null;
  stale: boolean;
}

export function deriveLiveness(
  lastSeenAt: number | null,
  now: number,
  offlineTimeoutMs: number = config.offlineTimeoutMs,
): Liveness {
  if (lastSeenAt === null) {
    return {
      status: "offline",
      online: false,
      offlineReason: "never_seen",
      dataAgeMs: null,
      stale: true,
    };
  }

  const dataAgeMs = Math.max(0, now - lastSeenAt);
  const online = dataAgeMs <= offlineTimeoutMs;

  return {
    status: online ? "online" : "offline",
    online,
    // A device that has reported before and then went quiet is "silent": we
    // cannot tell from here whether the board lost power or lost its link,
    // and inventing a distinction the data does not support would be a lie.
    offlineReason: online ? null : "silent",
    dataAgeMs,
    stale: dataAgeMs > config.staleDataMs,
  };
}

/** The highest reading across the three probes and the DHT sensor. */
/**
 * Buckets a measured RSSI against the configured bands for its radio.
 *
 * A live link whose firmware reports no RSSI is `unknown`, not `weak`: the
 * dashboard must not invent a quality it cannot measure. No distance is
 * derived from the value anywhere - only the reading itself.
 */
export function deriveSignal(
  frame: Pick<TelemetryFrame, "wifi" | "rssiDbm"> | null,
  online: boolean,
): SignalInfo {
  if (!online) {
    return { rssiDbm: null, quality: null, label: null, bars: 0, percent: null, reason: "offline" };
  }
  // A board serving its own SoftAP has no uplink whose strength could be
  // measured, so a reading there would be invented.
  if (frame?.wifi === "AP") {
    return {
      rssiDbm: null,
      quality: null,
      label: null,
      bars: 0,
      percent: null,
      reason: "access_point_mode",
    };
  }

  const rssi = frame?.rssiDbm ?? null;
  // 0 dBm is what an ESP32 returns when it is not associated, not a perfect
  // signal, so it counts as no reading.
  if (rssi === null || rssi === 0) {
    return {
      rssiDbm: null,
      quality: null,
      label: null,
      bars: 0,
      percent: null,
      reason: "not_reported",
    };
  }

  const band = SIGNAL_BANDS.find((entry) => rssi >= entry.min) ?? SIGNAL_BANDS[SIGNAL_BANDS.length - 1];
  // Linear across -100..-50 dBm: signal strength is logarithmic, but a bar is
  // not. `rssiDbm` remains the value to trust.
  const percent = Math.max(0, Math.min(100, Math.round(((rssi + 100) / 50) * 100)));

  return {
    rssiDbm: rssi,
    quality: band.quality,
    label: SIGNAL_LABEL[band.quality],
    bars: band.bars,
    percent,
    reason: null,
  };
}

export function hottestTemp(frame: TelemetryFrame | null): number | null {
  if (!frame) return null;
  const readings = [frame.temp1C, frame.temp2C, frame.temp3C, frame.temp4C, frame.dhtTempC].filter(
    (value): value is number => value !== null,
  );
  if (readings.length === 0) return frame.maxTempC;
  return Math.max(...readings);
}

/** Mean of whichever humidity probes actually reported. */
export function averageHumidity(frame: TelemetryFrame | null): number | null {
  if (!frame) return null;
  const readings = [frame.humidity1Pct, frame.humidity2Pct, frame.humidity3Pct].filter(
    (value): value is number => value !== null,
  );
  if (readings.length === 0) return null;
  return readings.reduce((sum, value) => sum + value, 0) / readings.length;
}

/** Ranks severities so "the worst open alert" is well defined. */
const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function worstSeverity(
  severities: readonly AlertSeverity[],
): AlertSeverity | null {
  let worst: AlertSeverity | null = null;
  for (const severity of severities) {
    if (worst === null || SEVERITY_RANK[severity] > SEVERITY_RANK[worst]) worst = severity;
  }
  return worst;
}

export interface BuildViewInput {
  record: DeviceRecord;
  telemetry: TelemetryFrame | null;
  channels: ChannelConfig[];
  settings: DeviceSettings | null;
  openAlertCount: number;
  worstAlertSeverity: AlertSeverity | null;
}

/**
 * Joins a device's stored rows into the shape the dashboard consumes.
 *
 * Offline devices keep their last frame - it is genuine history and useful for
 * diagnosis - but `heating` and `active` are forced false, because a heater we
 * have not heard from in a minute must never be drawn as currently running.
 */
export function buildDeviceView(input: BuildViewInput, now: number): DeviceView {
  const { record, telemetry, channels, settings, openAlertCount, worstAlertSeverity } = input;
  // A sensor board is judged against its own timeout, so the same device reads
  // the same on every page that shows it.
  const liveness = deriveLiveness(
    record.lastSeenAt,
    now,
    record.deviceType === "temphum" ? config.sensor.offlineTimeoutMs : config.offlineTimeoutMs,
  );

  const readings = new Map(telemetry?.channels.map((reading) => [reading.channelIndex, reading]));

  const channelViews: ChannelView[] = channels.map((channel) => {
    const reading = readings.get(channel.channelIndex) ?? null;
    return {
      ...channel,
      reading,
      active: Boolean(channel.enabled && reading?.isOn && liveness.online),
    };
  });

  const anyChannelOn = channelViews.some((channel) => channel.reading?.isOn === true);
  const faultCount = channelViews.filter(
    (channel) => channel.reading !== null && channel.reading.fault !== "ok",
  ).length;

  return {
    id: record.id,
    name: record.name,
    model: record.model,
    deviceType: record.deviceType,
    nameSource: record.nameSource,
    serialNumber: record.serialNumber,
    firmwareVersion: record.firmwareVersion,
    bluetoothName: record.bluetoothName,
    bluetoothAddress: record.bluetoothAddress,
    homeSsid: record.homeSsid,
    localAddress: record.localAddress,
    remoteAddress: record.remoteAddress,
    roomId: record.roomId,
    roomName: record.roomName,
    roomIcon: record.roomIcon,
    homeName: record.homeName,
    homeTimezone: record.homeTimezone,
    createdAt: record.createdAt,
    paired: record.deviceKeySetAt !== null,
    pairedAt: record.deviceKeySetAt,

    status: liveness.status,
    online: liveness.online,
    offlineReason: liveness.offlineReason,
    lastSeenAt: record.lastSeenAt,
    dataAgeMs: liveness.dataAgeMs,
    stale: liveness.stale,

    signal: deriveSignal(telemetry, liveness.online),

    telemetry,
    channels: channelViews,
    settings,

    hottestTempC: hottestTemp(telemetry),
    averageHumidityPct: averageHumidity(telemetry),
    heating: Boolean(liveness.online && telemetry && telemetry.level !== "off" && anyChannelOn),
    anyChannelOn,
    faultCount,
    openAlertCount,
    worstAlertSeverity,
    tripped: telemetry?.tripped ?? false,
  };
}

export interface StatsExtras {
  openAlerts: number;
  criticalAlerts: number;
  pendingCommands: number;
}

/**
 * Fleet counters for the overview strip.
 *
 * Electrical totals and temperature averages deliberately count online devices
 * only: summing the last known draw of a heater that has been dark for an hour
 * would report power the building is not using.
 */
export function computeStats(
  devices: readonly DeviceView[],
  extras: StatsExtras,
  now: number,
): FleetStats {
  const levels: Record<HeatLevel, number> = { off: 0, low: 0, medium: 0, high: 0 };
  const faults: Record<FaultCode, number> = {
    ok: 0,
    over_current: 0,
    no_load: 0,
    over_temperature: 0,
  };

  let online = 0;
  let neverSeen = 0;
  let stale = 0;
  let heating = 0;
  let tripped = 0;
  let climate = 0;
  let wifiSta = 0;
  let wifiAp = 0;
  let bluetoothClients = 0;
  let channelsOn = 0;
  let channelsTotal = 0;
  let channelFaults = 0;
  let totalPowerW = 0;
  let totalCurrentA = 0;

  const temps: number[] = [];
  const humidities: number[] = [];

  for (const device of devices) {
    channelsTotal += device.channels.length;

    if (device.offlineReason === "never_seen") neverSeen += 1;
    if (device.stale && device.lastSeenAt !== null) stale += 1;

    if (!device.online) continue;

    online += 1;
    if (device.heating) heating += 1;
    if (device.tripped) tripped += 1;

    const frame = device.telemetry;
    if (frame) {
      levels[frame.level] += 1;
      if (frame.climate) climate += 1;
      if (frame.wifi === "STA") wifiSta += 1;
      else wifiAp += 1;
      if (frame.bluetoothClient) bluetoothClients += 1;
      totalPowerW += frame.totalPowerW;
      totalCurrentA += frame.totalCurrentA;
    }

    for (const channel of device.channels) {
      if (!channel.reading) continue;
      if (channel.reading.isOn) channelsOn += 1;
      faults[channel.reading.fault] += 1;
      if (channel.reading.fault !== "ok") channelFaults += 1;
    }

    if (device.hottestTempC !== null) temps.push(device.hottestTempC);
    if (device.averageHumidityPct !== null) humidities.push(device.averageHumidityPct);
  }

  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    total: devices.length,
    online,
    offline: devices.length - online,
    neverSeen,
    stale,
    heating,
    tripped,
    climate,
    wifiSta,
    wifiAp,
    bluetoothClients,
    channelsOn,
    channelsTotal,
    channelFaults,
    openAlerts: extras.openAlerts,
    criticalAlerts: extras.criticalAlerts,
    pendingCommands: extras.pendingCommands,
    totalPowerW,
    totalCurrentA,
    averageTempC: mean(temps),
    hottestTempC: temps.length === 0 ? null : Math.max(...temps),
    averageHumidityPct: mean(humidities),
    levels,
    faults,
    generatedAt: now,
  };
}

/**
 * Orders devices for the "needs attention" list: the things that could start a
 * fire first, then faults, then things that are merely not talking.
 */
export function attentionScore(device: DeviceView): number {
  let score = 0;
  if (device.tripped) score += 1000;
  if (device.worstAlertSeverity === "critical") score += 500;
  if (device.faultCount > 0) score += 100 * device.faultCount;
  if (device.worstAlertSeverity === "warning") score += 50;
  if (device.openAlertCount > 0) score += 10 * device.openAlertCount;
  if (!device.online && device.offlineReason === "silent") score += 25;
  if (device.offlineReason === "never_seen") score += 5;
  if (device.stale && device.online) score += 2;
  return score;
}
