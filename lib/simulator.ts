import { config } from "./config";
import { query } from "./db";
import {
  ingestTelemetry,
  listDeviceViews,
  registerDevice,
  type ChannelInput,
  type TelemetryInput,
} from "./store";
import type { ChannelView, FaultCode, HeatLevel } from "./types";

/**
 * A virtual HEATER Ver1 fleet.
 *
 * This is not a UI mock. It calls the same `ingestTelemetry` the POST route
 * calls once it has validated a payload, so every value on the dashboard has
 * genuinely been written to Postgres, rolled into `energy_hourly` and put
 * through the alerting rules. Pull the plug with HEATER_SIM=off and the
 * dashboard goes quiet exactly as it would if real hardware stopped reporting.
 *
 * It exists so the dashboard can be developed and demonstrated before boards
 * are on the bench, and so the alerting paths get exercised - over-current,
 * no-load and over-temperature are rare on real hardware and very hard to
 * provoke deliberately.
 */

interface SimState {
  deviceId: string;
  /** Rolling ambient, so temperature drifts rather than jumping each frame. */
  ambientC: number;
  /** Core temperature of the heating element, which lags the demand. */
  coreC: number;
  level: HeatLevel;
  levelValue: number;
  climate: boolean;
  climateTargetC: number;
  manual: boolean;
  tripped: boolean;
  bootedAt: number;
  /** Frames until the current fault clears; 0 means healthy. */
  faultFor: number;
  faultChannel: number | null;
  faultKind: FaultCode;
  wifiDropFor: number;
  /**
   * Signal strength random-walks the way a real one does, so the dashboard's
   * Excellent/Good/Weak bands and the signal history chart have something
   * honest to show. One unit in the fleet reports no RSSI at all, which
   * exercises the "link up, strength unknown" path.
   */
  wifiRssi: number;
  reportsRssi: boolean;
}

declare global {
  var __heaterSim: { timer: NodeJS.Timeout; states: Map<string, SimState> } | undefined;
}

const LEVEL_VALUES: Record<HeatLevel, number> = { off: 0, low: 1, medium: 2, high: 3 };

/** Nominal draw per channel kind at mains voltage, in amps when fully on. */
const NOMINAL_CURRENT_A: Record<ChannelView["kind"], number> = {
  heater: 5.2,
  fan: 0.35,
  light: 0.08,
};

function jitter(value: number, spread: number): number {
  return value + (Math.random() - 0.5) * 2 * spread;
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function initialState(deviceId: string, now: number): SimState {
  return {
    deviceId,
    ambientC: jitter(19, 2),
    coreC: jitter(21, 2),
    level: "off",
    levelValue: 0,
    climate: Math.random() < 0.4,
    climateTargetC: Math.round(jitter(21, 2) * 2) / 2,
    manual: Math.random() < 0.3,
    tripped: false,
    bootedAt: now - Math.floor(Math.random() * 86_400_000),
    faultFor: 0,
    faultChannel: null,
    faultKind: "ok",
    wifiDropFor: 0,
    wifiRssi: -50 - (hash(deviceId) % 28),
    reportsRssi: hash(deviceId) % 6 !== 0,
  };
}

/**
 * Advances one virtual device by a tick and writes the frame.
 *
 * The physics is deliberately crude but directionally honest: the element's
 * core temperature chases a target set by the heat level, ambient follows the
 * core slowly, and current draw is proportional to how many heater channels are
 * energised. What matters is that the numbers move the way an operator would
 * expect, so a chart that looks wrong is a real bug rather than noise.
 */
async function tickDevice(state: SimState, channels: ChannelView[], now: number): Promise<void> {
  // --- decide what the unit is doing -----------------------------------------
  if (state.tripped) {
    // A trip latches until someone resets it; the simulator clears it after a
    // while so the dashboard shows recovery as well as failure.
    if (Math.random() < 0.05) state.tripped = false;
  } else if (state.climate) {
    // Thermostat: drive from the gap between ambient and the target.
    const gap = state.climateTargetC - state.ambientC;
    state.level = gap > 2.5 ? "high" : gap > 1 ? "medium" : gap > 0.2 ? "low" : "off";
  } else if (Math.random() < 0.12) {
    state.level = pick(["off", "low", "medium", "high"] as const);
  }

  if (state.tripped) state.level = "off";
  state.levelValue = LEVEL_VALUES[state.level];

  // --- fault injection --------------------------------------------------------
  if (state.faultFor > 0) {
    state.faultFor -= 1;
    if (state.faultFor === 0) {
      state.faultChannel = null;
      state.faultKind = "ok";
    }
  } else if (Math.random() < 0.02) {
    const candidates = channels.filter((channel) => channel.enabled);
    if (candidates.length > 0) {
      state.faultChannel = pick(candidates).channelIndex;
      state.faultKind = pick(["no_load", "over_current", "over_temperature"] as const);
      state.faultFor = 3 + Math.floor(Math.random() * 6);
    }
  }

  if (state.wifiDropFor > 0) state.wifiDropFor -= 1;
  else if (Math.random() < 0.015) state.wifiDropFor = 2 + Math.floor(Math.random() * 4);

  // Bounded random walk: signal drifts, occasionally into the weak band.
  const walk = (value: number, low: number, high: number) =>
    Math.min(high, Math.max(low, value + (Math.random() - 0.5) * 6));
  state.wifiRssi = walk(state.wifiRssi, -92, -38);

  // --- thermal model ----------------------------------------------------------
  const demand = state.levelValue / 3;
  const coreTarget = state.ambientC + demand * 55;
  state.coreC += (coreTarget - state.coreC) * 0.25;
  state.ambientC += (state.coreC - state.ambientC) * 0.012 - 0.02;
  state.ambientC = Math.max(8, Math.min(35, state.ambientC));

  // An over-temperature fault means the element really is too hot.
  if (state.faultKind === "over_temperature") state.coreC += 30;

  const mainsVoltageV = jitter(230, 4);

  // --- per-channel readings ---------------------------------------------------
  // Heater channels light up progressively with the level: "low" runs one
  // element, "high" runs all four. That is what makes total draw track the
  // level on the chart instead of being a flat line that ignores it.
  const heaterChannels = channels.filter((c) => c.kind === "heater" && c.enabled);
  const heatersOn = Math.min(heaterChannels.length, state.levelValue === 0 ? 0 : state.levelValue + 1);

  const readings: ChannelInput[] = [];
  let heaterSeen = 0;

  for (const channel of channels) {
    if (!channel.enabled) continue;

    let isOn = false;
    if (channel.kind === "heater") {
      isOn = !state.tripped && heaterSeen < heatersOn;
      heaterSeen += 1;
    } else if (channel.kind === "fan") {
      // Auto-fan runs whenever the element is hot, and keeps running after the
      // heat is cut so the core is not left to soak.
      isOn = !state.tripped && (state.levelValue > 0 || state.coreC > state.ambientC + 12);
    } else {
      isOn = state.levelValue > 0 && Math.random() < 0.6;
    }

    const isFaulted = state.faultChannel === channel.channelIndex;
    const fault: FaultCode = isFaulted ? state.faultKind : "ok";

    let currentA = isOn ? jitter(NOMINAL_CURRENT_A[channel.kind], 0.25) : 0;
    if (fault === "no_load") currentA = 0; // Switched on, drawing nothing.
    if (fault === "over_current") currentA = jitter(14, 1);

    const powerW = currentA * mainsVoltageV;

    readings.push({
      channelIndex: channel.channelIndex,
      channelId: channel.channelId,
      isOn,
      currentA: Math.max(0, Number(currentA.toFixed(3))),
      powerW: Math.max(0, Number(powerW.toFixed(2))),
      energyWh: 0,
      fault,
    });
  }

  const totalCurrentA = readings.reduce((sum, r) => sum + (r.currentA ?? 0), 0);

  // The board trips itself when total draw runs away, which is the behaviour
  // the protection limits exist to describe.
  if (totalCurrentA > 30 && Math.random() < 0.5) state.tripped = true;

  const frame: TelemetryInput = {
    level: state.level,
    levelValue: state.levelValue,
    mode: state.climate ? "CLIMATE" : state.manual ? "MANUAL" : state.level.toUpperCase(),
    manual: state.manual,
    autoFan: true,
    tripped: state.tripped,
    climate: state.climate,
    climateTargetC: state.climate ? state.climateTargetC : null,
    totalCurrentA: Number(totalCurrentA.toFixed(3)),
    sumCurrentA: Number(totalCurrentA.toFixed(3)),
    totalPowerW: Number((totalCurrentA * mainsVoltageV).toFixed(2)),
    readingSource: "CT SUM",
    meterVoltageV: Number(mainsVoltageV.toFixed(2)),
    mainsVoltageV: Number(mainsVoltageV.toFixed(2)),
    temp1C: Number(jitter(state.coreC, 1.2).toFixed(2)),
    temp2C: Number(jitter(state.coreC - 6, 1.2).toFixed(2)),
    temp3C: Number(jitter(state.ambientC + 3, 1).toFixed(2)),
    dhtTempC: Number(jitter(state.ambientC, 0.6).toFixed(2)),
    maxTempC: Number(Math.max(state.coreC, state.ambientC).toFixed(2)),
    humidity1Pct: Number(Math.min(95, Math.max(15, jitter(48, 6))).toFixed(2)),
    humidity2Pct: Number(Math.min(95, Math.max(15, jitter(51, 6))).toFixed(2)),
    humidity3Pct: Number(Math.min(95, Math.max(15, jitter(45, 6))).toFixed(2)),
    wifi: state.wifiDropFor > 0 ? "AP" : "STA",
    ip: state.wifiDropFor > 0 ? "192.168.4.1" : `192.168.1.${50 + (hash(state.deviceId) % 40)}`,
    bluetoothClient: state.wifiDropFor > 0 || Math.random() < 0.25,
    apiKeySet: true,
    uptimeSeconds: Math.floor((now - state.bootedAt) / 1000),
    // A board in AP mode has no uplink RSSI to report - it is the access point.
    rssiDbm: state.reportsRssi && state.wifiDropFor === 0 ? Math.round(state.wifiRssi) : null,
    channels: readings,
  };

  await ingestTelemetry(state.deviceId, frame, now);
}

/** Stable small integer from a uuid, so a device keeps the same IP each run. */
function hash(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    total = (total * 31 + value.charCodeAt(index)) >>> 0;
  }
  return total;
}

/**
 * Provisions extra virtual heaters so the dashboard has a fleet to show. They
 * are placed in the rooms that already exist rather than inventing new ones,
 * and are skipped entirely if they were provisioned on a previous run - the
 * serial number is unique, so re-registration updates rather than duplicates.
 */
async function provision(): Promise<void> {
  const rooms = await query<{ id: string; name: string }>(
    `SELECT id, name FROM rooms ORDER BY sort_order`,
  );
  if (rooms.length === 0) return;

  const existing = await query<{ serial_number: string | null }>(
    `SELECT serial_number FROM devices`,
  );
  const known = new Set(existing.map((row) => row.serial_number));

  for (let index = 0; index < config.simulator.extraDevices; index += 1) {
    const serialNumber = `HTR-VER1-SIM${String(index + 1).padStart(3, "0")}`;
    if (known.has(serialNumber)) continue;

    const room = rooms[(index + 1) % rooms.length];
    await registerDevice({
      name: `${room.name} Heater`,
      serialNumber,
      firmwareVersion: "1.0.0",
      model: "HEATER Ver1",
      bluetoothName: "HEATER_VER1",
      homeSsid: "AuraHome-2G",
      roomId: room.id,
    });
  }
}

async function tick(): Promise<void> {
  const sim = globalThis.__heaterSim;
  if (!sim) return;

  const now = Date.now();
  const devices = await listDeviceViews(now);

  for (const device of devices) {
    let state = sim.states.get(device.id);
    if (!state) {
      state = initialState(device.id, now);
      sim.states.set(device.id, state);
    }
    // A device with no configured channels has nothing to simulate.
    if (device.channels.length === 0) continue;

    try {
      await tickDevice(state, device.channels, now);
    } catch (error) {
      console.error(`[sim] tick failed for ${device.name}:`, error);
    }
  }

  // Devices deleted from the dashboard must not keep ticking.
  const live = new Set(devices.map((device) => device.id));
  for (const id of sim.states.keys()) if (!live.has(id)) sim.states.delete(id);
}

export async function startSimulator(): Promise<void> {
  if (!config.simulator.enabled || globalThis.__heaterSim) return;

  try {
    await provision();
  } catch (error) {
    console.error("[sim] provisioning failed:", error);
    return;
  }

  const timer = setInterval(() => {
    void tick().catch((error) => console.error("[sim] tick failed:", error));
  }, config.simulator.tickMs);
  timer.unref?.();

  globalThis.__heaterSim = { timer, states: new Map() };
  console.log(
    `[sim] virtual HEATER Ver1 fleet running every ${config.simulator.tickMs}ms (HEATER_SIM=off to disable)`,
  );
}

export function stopSimulator(): void {
  if (!globalThis.__heaterSim) return;
  clearInterval(globalThis.__heaterSim.timer);
  globalThis.__heaterSim = undefined;
}
