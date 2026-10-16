"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveDevices, useNow, useRecentlyUpdated } from "./live-store";
import {
  ChannelChip,
  ConnectivityBadge,
  SignalMeter,
  HeatLevelBadge,
  LiveTemp,
  StaleMarker,
  StatusBadge,
  TrippedBadge,
} from "./status";
import { Badge, Card, EmptyState, cx } from "./ui/primitives";
import { formatAge, formatCurrent, formatPercent, formatPower } from "@/lib/format";
import type { DeviceView } from "@/lib/types";

/**
 * The device index.
 *
 * Filtering runs against the live client-side mirror rather than re-querying
 * the server, so a filtered view keeps updating as telemetry arrives instead of
 * freezing at whatever the last request returned. A row that changes flashes,
 * which is what makes a busy fleet legible.
 */

type StatusFilter = "all" | "online" | "offline" | "heating" | "fault" | "tripped";
type ConnectionFilter = "all" | "sta" | "ap" | "bluetooth";
type SortKey =
  | "name"
  | "status"
  | "room"
  | "level"
  | "power"
  | "temperature"
  | "lastSeen"
  | "signal"
  | "alerts";

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
  { value: "heating", label: "Heating" },
  { value: "fault", label: "Faults & alerts" },
  { value: "tripped", label: "Tripped" },
];

const CONNECTION_OPTIONS: Array<{ value: ConnectionFilter; label: string }> = [
  { value: "all", label: "Any link" },
  { value: "sta", label: "Home Wi-Fi" },
  { value: "ap", label: "AP mode" },
  { value: "bluetooth", label: "Bluetooth client" },
];

const COLUMNS: Array<{ key: SortKey; label: string; align?: "right"; hideBelow?: string }> = [
  { key: "name", label: "Device" },
  { key: "status", label: "Status" },
  { key: "level", label: "Level" },
  { key: "power", label: "Draw", align: "right" },
  { key: "temperature", label: "Temp", align: "right" },
  { key: "lastSeen", label: "Last seen", align: "right" },
  { key: "signal", label: "Signal" },
];

export function DeviceTable({
  initialStatus = "all",
  initialConnection = "all",
  initialSort = "name",
  initialSortDir = "asc",
  initialRoom = "",
  rooms = [],
  pageSize = 15,
}: {
  initialStatus?: StatusFilter;
  initialConnection?: ConnectionFilter;
  initialSort?: SortKey;
  initialSortDir?: "asc" | "desc";
  initialRoom?: string;
  rooms?: Array<{ id: string; name: string; deviceCount: number }>;
  pageSize?: number;
}) {
  const devices = useLiveDevices();
  const now = useNow();
  const recentlyUpdated = useRecentlyUpdated();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [connection, setConnection] = useState<ConnectionFilter>(initialConnection);
  const [room, setRoom] = useState(initialRoom);
  const [sortBy, setSortBy] = useState<SortKey>(initialSort);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();

    const matches = devices.filter((device) => {
      if (needle) {
        const haystack = [
          device.name,
          device.serialNumber,
          device.roomName,
          device.model,
          device.firmwareVersion,
          device.telemetry?.ip,
          device.homeSsid,
          ...device.channels.map((channel) => channel.name),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
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
      return true;
    });

    const dir = sortDir === "desc" ? -1 : 1;

    // Unknown values sort last in both directions: a device with no reading is
    // not the coldest one, and floating it to the top would bury the devices an
    // operator actually opened this sort to find.
    const nullable = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a - b) * dir;
    };

    const levelRank = (device: DeviceView) =>
      device.telemetry ? ["off", "low", "medium", "high"].indexOf(device.telemetry.level) : -1;

    const attention = (device: DeviceView) =>
      (device.tripped ? 1000 : 0) +
      (device.worstAlertSeverity === "critical" ? 500 : 0) +
      device.faultCount * 100 +
      device.openAlertCount * 10;

    return [...matches].sort((a, b) => {
      switch (sortBy) {
        case "status": {
          const rank = (d: DeviceView) => (d.online ? (d.heating ? 0 : 1) : 2);
          return (rank(a) - rank(b)) * dir || a.name.localeCompare(b.name);
        }
        case "room":
          return (a.roomName ?? "").localeCompare(b.roomName ?? "") * dir || a.name.localeCompare(b.name);
        case "level":
          return (levelRank(a) - levelRank(b)) * dir || a.name.localeCompare(b.name);
        case "power":
          return (
            nullable(a.telemetry?.totalPowerW ?? null, b.telemetry?.totalPowerW ?? null) ||
            a.name.localeCompare(b.name)
          );
        case "temperature":
          return nullable(a.hottestTempC, b.hottestTempC) || a.name.localeCompare(b.name);
        case "lastSeen":
          return nullable(a.lastSeenAt, b.lastSeenAt) || a.name.localeCompare(b.name);
        case "signal": {
          // Ranked worst-first so one click surfaces the marginal installs.
          // Unmeasured and absent links sort together at the bottom.
          // No reading sorts with the worst, so one click surfaces the links
          // that need attention rather than hiding them mid-list.
          const rank = (d: DeviceView) =>
            d.signal.quality === null
              ? -1
              : { excellent: 4, good: 3, fair: 2, weak: 1, unusable: 0 }[d.signal.quality];
          return (rank(a) - rank(b)) * dir || a.name.localeCompare(b.name);
        }
        case "alerts":
          return (attention(a) - attention(b)) * dir || a.name.localeCompare(b.name);
        case "name":
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    });
  }, [devices, search, status, connection, room, sortBy, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      // Bigger-is-more-interesting for measurements; alphabetical for names.
      setSortDir(key === "name" || key === "room" ? "asc" : "desc");
    }
    setPage(1);
  };

  const resetPage = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border-base px-4 py-3 sm:px-5 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-xs">
          <input
            type="search"
            value={search}
            onChange={(event) => resetPage(setSearch)(event.target.value)}
            placeholder="Search name, serial, room, IP…"
            aria-label="Search devices"
            className="w-full rounded-lg border border-border-base bg-surface py-2 pr-3 pl-8 text-sm placeholder:text-muted"
          />
          <svg
            viewBox="0 0 16 16"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" fill="none" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            label="Status"
            value={status}
            onChange={(value) => resetPage(setStatus)(value as StatusFilter)}
            options={STATUS_OPTIONS}
          />
          <Select
            label="Link"
            value={connection}
            onChange={(value) => resetPage(setConnection)(value as ConnectionFilter)}
            options={CONNECTION_OPTIONS}
          />
          {rooms.length > 0 ? (
            <Select
              label="Room"
              value={room}
              onChange={(value) => resetPage(setRoom)(value)}
              options={[
                { value: "", label: "All rooms" },
                ...rooms.map((entry) => ({
                  value: entry.id,
                  label: `${entry.name} (${entry.deviceCount})`,
                })),
              ]}
            />
          ) : null}
        </div>

        <p className="text-xs text-muted lg:ml-auto">
          {filtered.length} of {devices.length} devices
        </p>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No devices match these filters"
          description="Clear the search or widen the filters to see the rest of the fleet."
        />
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border-base text-left">
                {COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cx(
                      "px-4 py-2 text-[11px] font-medium tracking-wide text-muted uppercase",
                      column.align === "right" && "text-right",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      aria-label={`Sort by ${column.label}`}
                    >
                      {column.label}
                      <SortGlyph active={sortBy === column.key} dir={sortDir} />
                    </button>
                  </th>
                ))}
                <th scope="col" className="px-4 py-2 text-[11px] font-medium tracking-wide text-muted uppercase">
                  Channels
                </th>
                <th scope="col" className="px-4 py-2 text-[11px] font-medium tracking-wide text-muted uppercase">
                  Link
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  now={now}
                  flash={recentlyUpdated.has(device.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-3 border-t border-border-base px-4 py-2.5 text-xs sm:px-5">
          <p className="text-muted">
            Page {currentPage} of {pageCount}
          </p>
          <div className="flex gap-1.5">
            <PageButton disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>
              Previous
            </PageButton>
            <PageButton disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>
              Next
            </PageButton>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function DeviceRow({ device, now, flash }: { device: DeviceView; now: number; flash: boolean }) {
  const frame = device.telemetry;
  const age = device.lastSeenAt === null ? null : now - device.lastSeenAt;

  return (
    <tr className={cx("border-b border-border-base last:border-0", flash && "row-flash")}>
      <td className="px-4 py-2.5">
        <Link href={`/devices/${device.id}`} className="font-medium hover:text-accent">
          {device.name}
        </Link>
        <p className="mt-0.5 truncate text-[11px] text-muted">
          {[device.roomName, device.serialNumber].filter(Boolean).join(" · ") || device.model}
        </p>
      </td>

      <td className="px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge device={device} />
          {!device.paired ? (
            <Badge tone="warn" title="Added on the portal; the board has not claimed it yet">
              Waiting for board
            </Badge>
          ) : null}
          {device.tripped ? <TrippedBadge /> : null}
          {device.online && device.stale ? <StaleMarker ageMs={age} /> : null}
          {device.openAlertCount > 0 ? (
            <Badge tone={device.worstAlertSeverity === "critical" ? "danger" : "warn"}>
              {device.openAlertCount} alert{device.openAlertCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
      </td>

      <td className="px-4 py-2.5">
        {frame && device.online ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <HeatLevelBadge level={frame.level} />
            {frame.climate ? <Badge tone="wifi">Climate</Badge> : null}
          </div>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>

      <td className="px-4 py-2.5 text-right">
        {frame && device.online ? (
          <>
            <span className="tabular font-medium">{formatPower(frame.totalPowerW)}</span>
            <p className="tabular mt-0.5 text-[11px] text-muted">
              {formatCurrent(frame.totalCurrentA)}
            </p>
          </>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>

      <td className="px-4 py-2.5 text-right">
        <LiveTemp device={device} value={device.hottestTempC} className="font-medium" />
        {device.online && device.averageHumidityPct !== null ? (
          <p className="tabular mt-0.5 text-[11px] text-muted">
            {formatPercent(device.averageHumidityPct)} RH
          </p>
        ) : null}
      </td>

      <td className="tabular px-4 py-2.5 text-right text-muted">{formatAge(age)}</td>

      <td className="px-4 py-2.5">
        <SignalMeter device={device} />
      </td>

      <td className="px-4 py-2.5">
        <div className="flex flex-wrap gap-1">
          {device.channels.length === 0 ? (
            <span className="text-[11px] text-muted">none configured</span>
          ) : (
            device.channels.map((channel) => (
              <ChannelChip key={channel.channelIndex} channel={channel} online={device.online} />
            ))
          )}
        </div>
      </td>

      <td className="px-4 py-2.5">
        <ConnectivityBadge device={device} />
      </td>
    </tr>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="rounded-lg border border-border-base bg-surface px-2.5 py-2 text-xs"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SortGlyph({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  return (
    <svg viewBox="0 0 8 10" aria-hidden className={cx("size-2", active ? "text-accent" : "text-border-strong")}>
      <path d="M4 0 7 4H1z" fill={active && dir === "asc" ? "currentColor" : "var(--border-strong)"} />
      <path d="M4 10 1 6h6z" fill={active && dir === "desc" ? "currentColor" : "var(--border-strong)"} />
    </svg>
  );
}

function PageButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-border-base px-2.5 py-1.5 font-medium disabled:opacity-40 enabled:hover:border-accent/50"
    >
      {children}
    </button>
  );
}
