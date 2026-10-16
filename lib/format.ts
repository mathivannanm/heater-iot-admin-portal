import { displayTimezone } from "./config";
import type {
  AlertSeverity,
  ChannelKind,
  DeviceView,
  FaultCode,
  HeatLevel,
  OfflineReason,
  SignalQuality,
  SignalReason,
  WifiMode,
} from "./types";

/** Presentation helpers shared by server and client components. */

/**
 * Absolute times render in one fixed zone on both the server and the browser.
 * Without this the server formats in its own timezone and the client re-formats
 * in the viewer's, which is a hydration mismatch waiting for the first
 * deployment where the two differ. Inlined at build time via the NEXT_PUBLIC_
 * prefix so both bundles see the identical literal.
 */
export const DISPLAY_TIME_ZONE = displayTimezone;

const TIME_FORMAT = { timeZone: DISPLAY_TIME_ZONE } as const;

/** The em-dash used everywhere a value is genuinely unknown. */
export const NO_VALUE = "—";

export function formatTemp(value: number | null | undefined, places = 1): string {
  if (value === null || value === undefined) return NO_VALUE;
  return `${value.toFixed(places)}°C`;
}

/** Signal strength in dBm, the unit an installer's survey tool also reports. */
export function formatRssi(value: number | null | undefined): string {
  if (value === null || value === undefined) return NO_VALUE;
  return `${Math.round(value)} dBm`;
}

export function formatPercent(value: number | null | undefined, places = 0): string {
  if (value === null || value === undefined) return NO_VALUE;
  return `${value.toFixed(places)}%`;
}

export function formatCurrent(value: number | null | undefined, places = 2): string {
  if (value === null || value === undefined) return NO_VALUE;
  return `${value.toFixed(places)} A`;
}

export function formatVoltage(value: number | null | undefined, places = 0): string {
  if (value === null || value === undefined) return NO_VALUE;
  return `${value.toFixed(places)} V`;
}

/** Watts below a kilowatt, kilowatts above, because a heater spans both. */
export function formatPower(value: number | null | undefined): string {
  if (value === null || value === undefined) return NO_VALUE;
  if (Math.abs(value) < 1000) return `${Math.round(value)} W`;
  return `${(value / 1000).toFixed(2)} kW`;
}

export function formatEnergy(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return NO_VALUE;
  if (Math.abs(wh) < 1000) return `${wh.toFixed(0)} Wh`;
  return `${(wh / 1000).toFixed(2)} kWh`;
}

/**
 * Compact relative age, e.g. "just now", "42s ago", "3 min ago".
 * Deliberately coarse above an hour: an operator scanning a table wants
 * "2 h ago", not a precise duration.
 */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "never";
  if (ms < 3_000) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return NO_VALUE;
  return formatDuration(seconds * 1000);
}

/**
 * Absolute clock time. Fixed to en-GB 24-hour so server and client render the
 * same string and hydration stays quiet regardless of the viewer's locale.
 */
export function formatClock(t: number | null | undefined): string {
  if (t === null || t === undefined) return NO_VALUE;
  return new Date(t).toLocaleTimeString("en-GB", {
    ...TIME_FORMAT,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDateTime(t: number | null | undefined): string {
  if (t === null || t === undefined) return NO_VALUE;
  return new Date(t).toLocaleString("en-GB", {
    ...TIME_FORMAT,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDate(t: number | null | undefined): string {
  if (t === null || t === undefined) return NO_VALUE;
  return new Date(t).toLocaleDateString("en-GB", {
    ...TIME_FORMAT,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Short label for a chart axis: time of day, or the date for wide ranges. */
export function formatAxisTime(t: number, spanMs: number): string {
  const date = new Date(t);
  if (spanMs > 3 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString("en-GB", { ...TIME_FORMAT, day: "2-digit", month: "short" });
  }
  return date.toLocaleTimeString("en-GB", {
    ...TIME_FORMAT,
    hour: "2-digit",
    minute: "2-digit",
  });
}

// -------------------------------------------------------------------- labels

export const HEAT_LEVEL_LABEL: Record<HeatLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

export const CHANNEL_KIND_LABEL: Record<ChannelKind, string> = {
  heater: "Heater",
  fan: "Fan",
  light: "Light",
};

export const FAULT_LABEL: Record<FaultCode, string> = {
  ok: "OK",
  over_current: "Over current",
  no_load: "No load",
  over_temperature: "Over temperature",
};

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

export const WIFI_MODE_LABEL: Record<WifiMode, string> = {
  AP: "Access point",
  STA: "Home Wi-Fi",
};

/** The API's band labels, verbatim, so both surfaces read the same. */
export const SIGNAL_LABEL: Record<SignalQuality, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  weak: "Weak",
  unusable: "Unusable",
};

/** Why a link has no reading. Never rendered as a weak signal. */
export const SIGNAL_REASON_LABEL: Record<SignalReason, string> = {
  not_reported: "Not reported",
  access_point_mode: "Access point mode",
  offline: "Offline",
};

export const OFFLINE_REASON_LABEL: Record<OfflineReason, string> = {
  never_seen: "Never reported",
  silent: "Stopped reporting",
};

/** Turns an audit action key like `device.updated` into "Device updated". */
export function formatAuditAction(action: string): string {
  const words = action.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * How a device's connectivity should read in one short phrase.
 *
 * The hardware reports a Wi-Fi *mode*, not a signal strength: "AP" means it
 * fell back to serving its own access point, which in practice means it could
 * not reach the home network and is the thing an operator needs to notice.
 */
export function connectivityLabel(device: DeviceView): string {
  const frame = device.telemetry;
  if (!frame) return "Never connected";
  if (!device.online) return "Offline";
  if (frame.wifi === "AP") return frame.bluetoothClient ? "Access point + BLE" : "Access point";
  return frame.bluetoothClient ? "Home Wi-Fi + BLE" : "Home Wi-Fi";
}

/** One-line summary of what a device is doing right now. */
export function activityLabel(device: DeviceView): string {
  if (!device.online) return OFFLINE_REASON_LABEL[device.offlineReason ?? "silent"];
  if (device.tripped) return "Protection tripped";
  const frame = device.telemetry;
  if (!frame) return "No readings";
  if (frame.climate && frame.climateTargetC !== null) {
    return `Climate ${formatTemp(frame.climateTargetC, 1)}`;
  }
  if (frame.level === "off") return "Idle";
  return `Heating — ${HEAT_LEVEL_LABEL[frame.level].toLowerCase()}`;
}
