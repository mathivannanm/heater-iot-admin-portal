import {
  CHANNEL_KIND_LABEL,
  FAULT_LABEL,
  HEAT_LEVEL_LABEL,
  OFFLINE_REASON_LABEL,
  SEVERITY_LABEL,
  SIGNAL_LABEL,
  SIGNAL_REASON_LABEL,
  formatAge,
  formatRssi,
  formatTemp,
} from "@/lib/format";
import type {
  AlertSeverity,
  ChannelKind,
  ChannelView,
  DeviceView,
  FaultCode,
  HeatLevel,
  SignalQuality,
} from "@/lib/types";
import { Badge, Dot, cx, type Tone } from "./ui/primitives";

/**
 * The status vocabulary.
 *
 * Colour carries meaning consistently across every screen: green is healthy,
 * amber is worth a look, deep red is a fault, orange means an element is
 * actually running, teal and blue distinguish the two radios. Brand red is
 * reserved for structure and interaction, so it never competes with alarm red.
 */

export function StatusBadge({ device }: { device: DeviceView }) {
  if (device.online) {
    return (
      <Badge tone={device.heating ? "heat" : "ok"}>
        <Dot tone={device.heating ? "heat" : "ok"} pulse />
        {device.heating ? "Heating" : "Online"}
      </Badge>
    );
  }

  const reason = device.offlineReason ?? "silent";
  return (
    <Badge tone="neutral" title={OFFLINE_REASON_LABEL[reason]}>
      <Dot tone="neutral" />
      {reason === "never_seen" ? "Never seen" : "Offline"}
    </Badge>
  );
}

const HEAT_TONE: Record<HeatLevel, Tone> = {
  off: "neutral",
  low: "wifi",
  medium: "warn",
  high: "heat",
};

export function HeatLevelBadge({ level, muted = false }: { level: HeatLevel; muted?: boolean }) {
  return (
    <Badge tone={muted ? "neutral" : HEAT_TONE[level]}>{HEAT_LEVEL_LABEL[level]}</Badge>
  );
}

const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  info: "wifi",
  warning: "warn",
  critical: "danger",
};

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

const FAULT_TONE: Record<FaultCode, Tone> = {
  ok: "ok",
  over_current: "danger",
  no_load: "warn",
  over_temperature: "danger",
};

export function FaultBadge({ fault }: { fault: FaultCode }) {
  if (fault === "ok") return <span className="text-xs text-muted">OK</span>;
  return <Badge tone={FAULT_TONE[fault]}>{FAULT_LABEL[fault]}</Badge>;
}

const KIND_TONE: Record<ChannelKind, Tone> = {
  heater: "heat",
  fan: "wifi",
  light: "warn",
};

export function ChannelKindBadge({ kind }: { kind: ChannelKind }) {
  return <Badge tone={KIND_TONE[kind]}>{CHANNEL_KIND_LABEL[kind]}</Badge>;
}

/**
 * Connectivity, expressed the way the hardware actually reports it.
 *
 * Wi-Fi mode is the interesting part: "AP" means the heater could not reach the
 * home network and fell back to serving its own access point, which is a
 * problem an operator should see. Signal strength is a separate concern -
 * see SignalMeter.
 */
export function ConnectivityBadge({ device }: { device: DeviceView }) {
  const frame = device.telemetry;
  if (!frame) return <span className="text-xs text-muted">—</span>;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {frame.wifi === "STA" ? (
        <Badge tone={device.online ? "wifi" : "neutral"} title={frame.ip ?? undefined}>
          <Dot tone={device.online ? "wifi" : "neutral"} />
          Wi-Fi
        </Badge>
      ) : (
        <Badge tone="warn" title="Fell back to its own access point — it could not join the home network">
          <Dot tone="warn" />
          AP mode
        </Badge>
      )}
      {frame.bluetoothClient ? (
        <Badge tone={device.online ? "bt" : "neutral"} title="A phone is connected over Bluetooth">
          BLE
        </Badge>
      ) : null}
    </span>
  );
}

const SIGNAL_FILL: Record<SignalQuality, string> = {
  excellent: "bg-ok",
  good: "bg-ok",
  fair: "bg-warn",
  weak: "bg-warn",
  unusable: "bg-danger",
};

/**
 * Four-bar signal meter, rendered from the band the API chose.
 *
 * The bar count comes from the API rather than being re-derived here, so this
 * dashboard and the mobile app can never disagree about whether a link is
 * "Good" or "Fair". Three states are kept distinct and never conflated: a
 * measured strength, a live link the firmware reports no RSSI for, and a board
 * in access-point mode which has no uplink to measure at all.
 */
export function SignalMeter({
  device,
  showValue = false,
}: {
  device: Pick<DeviceView, "signal">;
  showValue?: boolean;
}) {
  const { quality, rssiDbm, percent, bars, reason } = device.signal;

  const title =
    quality === null
      ? reason === "access_point_mode"
        ? "Serving its own access point — no uplink whose strength could be measured"
        : reason === "offline"
          ? "Device is offline"
          : "Connected — this firmware does not report signal strength"
      : `${SIGNAL_LABEL[quality]} · ${formatRssi(rssiDbm)}${percent === null ? "" : ` · ${percent}%`}`;

  return (
    <span className="inline-flex items-center gap-2" title={title}>
      <span className="inline-flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3, 4].map((bar) => (
          <span
            key={bar}
            className={cx(
              "w-[3px] rounded-[1px]",
              quality !== null && bar <= bars ? SIGNAL_FILL[quality] : "bg-border-base",
              bar === 1 && "h-1.5",
              bar === 2 && "h-2.5",
              bar === 3 && "h-3.5",
              bar === 4 && "h-[18px]",
            )}
          />
        ))}
      </span>
      <span className={cx("text-xs", quality === null ? "text-muted" : "text-foreground")}>
        {quality === null
          ? reason === null
            ? "—"
            : SIGNAL_REASON_LABEL[reason]
          : SIGNAL_LABEL[quality]}
      </span>
      {showValue && rssiDbm !== null ? (
        <span className="tabular text-xs text-muted">{formatRssi(rssiDbm)}</span>
      ) : null}
      <span className="sr-only">{title}</span>
    </span>
  );
}

export function TrippedBadge() {
  return (
    <Badge tone="danger" title="Protection has cut power and stays latched until reset">
      Tripped
    </Badge>
  );
}

/**
 * Marks a reading that is too old to present as current.
 *
 * Stale data is labelled rather than hidden: the value is still the last thing
 * the heater said, which is useful for diagnosis, but it must never be mistaken
 * for what the heater is doing now.
 */
export function StaleMarker({ ageMs }: { ageMs: number | null }) {
  return (
    <span
      className="text-[11px] font-medium text-warn"
      title={`Last reading ${formatAge(ageMs)} — not live`}
    >
      not live
    </span>
  );
}

/**
 * A temperature that knows whether it is trustworthy.
 * Offline devices show a dash: their last reading is history, not a measurement.
 */
export function LiveTemp({
  device,
  value,
  places = 1,
  className,
}: {
  device: DeviceView;
  value: number | null;
  places?: number;
  className?: string;
}) {
  if (!device.online || value === null) {
    return <span className={cx("tabular text-muted", className)}>—</span>;
  }
  return (
    <span className={cx("tabular", device.stale && "text-muted-strong", className)}>
      {formatTemp(value, places)}
    </span>
  );
}

/** Compact per-channel chip used in the device table and the detail header. */
export function ChannelChip({ channel, online }: { channel: ChannelView; online: boolean }) {
  const reading = channel.reading;
  const faulted = reading !== null && reading.fault !== "ok";
  const on = Boolean(online && reading?.isOn);

  const tone: Tone = !channel.enabled
    ? "neutral"
    : faulted
      ? "danger"
      : on
        ? KIND_TONE[channel.kind]
        : "neutral";

  const title = !channel.enabled
    ? `${channel.name} — disabled`
    : faulted
      ? `${channel.name} — ${FAULT_LABEL[reading!.fault]}`
      : `${channel.name} — ${on ? "on" : "off"}`;

  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "bg-idle-soft text-muted-strong",
        tone === "heat" && "bg-heat-soft text-heat",
        tone === "wifi" && "bg-wifi-soft text-wifi",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "danger" && "bg-danger-soft text-danger",
        !channel.enabled && "opacity-60",
      )}
    >
      {faulted ? <Dot tone="danger" /> : on ? <Dot tone={tone} pulse /> : null}
      {channel.channelId}
    </span>
  );
}
