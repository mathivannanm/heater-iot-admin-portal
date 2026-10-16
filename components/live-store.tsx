"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DeviceAlert, DeviceView, FleetStats, StreamMessage, StreamReason } from "@/lib/types";

/**
 * Client-side mirror of the fleet, fed by the SSE stream at /api/events.
 *
 * The server renders the first paint from the store directly, so the page is
 * populated before any JavaScript runs; this provider then takes over and
 * applies per-device patches as they arrive. Nothing here polls.
 */

export type StreamState = "connecting" | "live" | "reconnecting";

export interface FeedEntry {
  id: string;
  deviceId: string;
  deviceName: string;
  reason: StreamReason;
  t: number;
  /** Set when the entry came from an alert rather than a device transition. */
  alert?: { code: string; severity: DeviceAlert["severity"]; message: string };
}

/**
 * Telemetry arrives every few seconds per device. It keeps the values fresh but
 * would drown the activity feed, so the feed ignores it and shows only the
 * transitions a person would want to be told about.
 */
const NOISY_REASONS = new Set<StreamReason>(["telemetry"]);

export interface Thresholds {
  telemetryIntervalMs: number;
  offlineTimeoutMs: number;
  staleDataMs: number;
}

interface LiveContextValue {
  devices: Map<string, DeviceView>;
  stats: FleetStats;
  streamState: StreamState;
  thresholds: Thresholds;
  /** Ticking clock so relative ages re-render without each component polling. */
  now: number;
  lastEventAt: number | null;
  /** Device IDs updated within the last moment, for the row-flash affordance. */
  recentlyUpdated: Set<string>;
  /** Rolling fleet-wide activity log, newest first. */
  feed: FeedEntry[];
}

const FEED_LIMIT = 60;

/**
 * One shared 1 Hz clock for every "x seconds ago" label on the page.
 *
 * Read through `useSyncExternalStore` rather than `useState` + an interval,
 * because relative times are the classic hydration hazard: the server renders
 * "just now", and by the time the browser hydrates the same packet is three
 * seconds old. The server snapshot is the timestamp the page was rendered at,
 * so the first client render reproduces the server's HTML exactly; React then
 * swaps in the live value once hydration is finished.
 */
const clock = {
  value: 0,
  listeners: new Set<() => void>(),
  timer: null as ReturnType<typeof setInterval> | null,
};

function subscribeToClock(onStoreChange: () => void): () => void {
  clock.listeners.add(onStoreChange);
  if (!clock.timer) {
    clock.timer = setInterval(() => {
      clock.value = Date.now();
      for (const listener of clock.listeners) listener();
    }, 1000);
  }
  return () => {
    clock.listeners.delete(onStoreChange);
    if (clock.listeners.size === 0 && clock.timer) {
      clearInterval(clock.timer);
      clock.timer = null;
    }
  };
}

// Cached so repeated reads within one render pass return the same value.
function getClockSnapshot(): number {
  if (clock.value === 0) clock.value = Date.now();
  return clock.value;
}

const LiveContext = createContext<LiveContextValue | null>(null);

function toMap(devices: DeviceView[]): Map<string, DeviceView> {
  return new Map(devices.map((device) => [device.id, device]));
}

export function LiveProvider({
  initialDevices,
  initialStats,
  thresholds,
  serverNow,
  children,
}: {
  initialDevices: DeviceView[];
  initialStats: FleetStats;
  thresholds: Thresholds;
  /** The instant the server built `initialDevices`; anchors hydration. */
  serverNow: number;
  children: React.ReactNode;
}) {
  const [devices, setDevices] = useState(() => toMap(initialDevices));
  const [stats, setStats] = useState(initialStats);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(() => new Set());
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const flash = useCallback((deviceId: string) => {
    setRecentlyUpdated((previous) => {
      if (previous.has(deviceId)) return previous;
      const next = new Set(previous);
      next.add(deviceId);
      return next;
    });
    const timers = flashTimers.current;
    clearTimeout(timers.get(deviceId));
    timers.set(
      deviceId,
      setTimeout(() => {
        setRecentlyUpdated((previous) => {
          if (!previous.has(deviceId)) return previous;
          const next = new Set(previous);
          next.delete(deviceId);
          return next;
        });
        timers.delete(deviceId);
      }, 1200),
    );
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");

    const apply = (raw: string) => {
      let message: StreamMessage;
      try {
        message = JSON.parse(raw) as StreamMessage;
      } catch {
        return;
      }
      setLastEventAt(Date.now());

      switch (message.kind) {
        case "snapshot":
          setDevices(toMap(message.devices));
          setStats(message.stats);
          break;
        case "device":
          // Replace only the device that changed; every other row keeps its
          // identity and does not re-render.
          setDevices((previous) => {
            const next = new Map(previous);
            next.set(message.device.id, message.device);
            return next;
          });
          if (!NOISY_REASONS.has(message.reason)) {
            flash(message.device.id);
            setFeed((previous) =>
              [
                {
                  id: `${message.device.id}-${message.reason}-${message.t}`,
                  deviceId: message.device.id,
                  deviceName: message.device.name,
                  reason: message.reason,
                  t: message.t,
                },
                ...previous,
              ].slice(0, FEED_LIMIT),
            );
          }
          break;
        case "alert":
          flash(message.alert.deviceId);
          setFeed((previous) =>
            [
              {
                id: `alert-${message.alert.id}-${message.t}`,
                deviceId: message.alert.deviceId,
                deviceName: message.alert.deviceName,
                reason: "updated" as StreamReason,
                t: message.t,
                alert: {
                  code: message.alert.code,
                  severity: message.alert.severity,
                  message: message.alert.message,
                },
              },
              ...previous,
            ].slice(0, FEED_LIMIT),
          );
          break;
        case "device_removed":
          setDevices((previous) => {
            if (!previous.has(message.deviceId)) return previous;
            const next = new Map(previous);
            next.delete(message.deviceId);
            return next;
          });
          break;
        case "stats":
          setStats(message.stats);
          break;
      }
    };

    const onMessage = (event: MessageEvent<string>) => apply(event.data);

    source.addEventListener("open", () => setStreamState("live"));
    for (const kind of ["snapshot", "device", "device_removed", "stats", "alert"]) {
      source.addEventListener(kind, onMessage as EventListener);
    }
    // EventSource reconnects on its own; surface the gap rather than hide it.
    source.addEventListener("error", () => setStreamState("reconnecting"));

    return () => source.close();
  }, [flash]);

  // Separate effect so the timer map is captured at mount, not read at teardown.
  useEffect(() => {
    const timers = flashTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const getServerClockSnapshot = useCallback(() => serverNow, [serverNow]);
  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);

  const value = useMemo<LiveContextValue>(
    () => ({ devices, stats, streamState, thresholds, now, lastEventAt, recentlyUpdated, feed }),
    [devices, stats, streamState, thresholds, now, lastEventAt, recentlyUpdated, feed],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function useLive(): LiveContextValue {
  const context = useContext(LiveContext);
  if (!context) throw new Error("useLive must be used inside <LiveProvider>");
  return context;
}

export function useLiveDevices(): DeviceView[] {
  const { devices } = useLive();
  return useMemo(() => [...devices.values()], [devices]);
}

/**
 * A single device, falling back to the server-rendered copy until the first
 * snapshot lands so the detail page never blanks out on navigation.
 */
export function useLiveDevice(fallback: DeviceView): DeviceView {
  const { devices } = useLive();
  return devices.get(fallback.id) ?? fallback;
}

export function useLiveStats(): FleetStats {
  return useLive().stats;
}

export function useStreamStatus(): {
  streamState: StreamState;
  lastEventAt: number | null;
  now: number;
} {
  const { streamState, lastEventAt, now } = useLive();
  return { streamState, lastEventAt, now };
}

export function useNow(): number {
  return useLive().now;
}

export function useThresholds(): Thresholds {
  return useLive().thresholds;
}

export function useRecentlyUpdated(): Set<string> {
  return useLive().recentlyUpdated;
}

export function useLiveFeed(): FeedEntry[] {
  return useLive().feed;
}
