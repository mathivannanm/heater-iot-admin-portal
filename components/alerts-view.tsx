"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveStats, useNow } from "./live-store";
import { SeverityBadge } from "./status";
import { Badge, Card, CardHeader, EmptyState, cx } from "./ui/primitives";
import { formatAge, formatDateTime } from "@/lib/format";
import type { AlertSeverity, DeviceAlert } from "@/lib/types";

/**
 * The fleet fault log.
 *
 * Open alerts first, because that is what an operator opens this page to see.
 * Acknowledging records that a human has looked; it never clears the alert -
 * only a frame that no longer carries the condition does that, so the list
 * cannot be made to look healthy by clicking.
 */

const SEVERITIES: Array<{ value: "all" | AlertSeverity; label: string }> = [
  { value: "all", label: "All severities" },
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
];

export function AlertsView({ initial }: { initial: DeviceAlert[] }) {
  const now = useNow();
  const stats = useLiveStats();

  const [alerts, setAlerts] = useState(initial);
  const [showOpen, setShowOpen] = useState(true);
  const [severity, setSeverity] = useState<"all" | AlertSeverity>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (open: boolean) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/alerts?open=${open}&limit=200`, { cache: "no-store" });
      if (response.ok) {
        const body = (await response.json()) as { alerts: DeviceAlert[] };
        setAlerts(body.alerts);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // The open count comes from the live stats stream, so when it changes the
  // list behind it is out of date and needs re-reading.
  //
  // This background refresh deliberately does not go through `load`: it must
  // not raise the loading flag (the table would flicker every time an alert
  // clears anywhere in the fleet), and it must not set state synchronously
  // while the effect is running, which cascades renders.
  useEffect(() => {
    if (!showOpen) return;

    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/alerts?open=true&limit=200", { cache: "no-store" });
      if (cancelled || !response.ok) return;
      const body = (await response.json()) as { alerts: DeviceAlert[] };
      if (!cancelled) setAlerts(body.alerts);
    })();

    return () => {
      cancelled = true;
    };
  }, [stats.openAlerts, showOpen]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return alerts.filter((alert) => {
      if (severity !== "all" && alert.severity !== severity) return false;
      if (!needle) return true;
      return [alert.deviceName, alert.code, alert.message, alert.channelId]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [alerts, severity, search]);

  const acknowledge = async (alert: DeviceAlert) => {
    setBusy(alert.id);
    try {
      const response = await fetch(`/api/devices/${alert.deviceId}/alerts`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alertId: alert.id }),
      });
      if (response.ok) {
        setAlerts((previous) =>
          previous.map((entry) =>
            entry.id === alert.id ? { ...entry, acknowledgedAt: Date.now() } : entry,
          ),
        );
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title={showOpen ? "Open alerts" : "Resolved alerts"}
        description={
          loading
            ? "Loading…"
            : `${visible.length} shown · ${stats.criticalAlerts} critical open across the fleet`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {[
                { key: true, label: "Open" },
                { key: false, label: "Resolved" },
              ].map((option) => (
                <button
                  key={String(option.key)}
                  type="button"
                  onClick={() => {
                    setShowOpen(option.key);
                    void load(option.key);
                  }}
                  aria-pressed={showOpen === option.key}
                  className={cx(
                    "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                    showOpen === option.key
                      ? "bg-accent-soft text-accent"
                      : "text-muted-strong hover:bg-surface-muted",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <select
              value={severity}
              onChange={(event) => setSeverity(event.target.value as "all" | AlertSeverity)}
              aria-label="Filter by severity"
              className="rounded-lg border border-border-base bg-surface px-2.5 py-2 text-xs"
            >
              {SEVERITIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search…"
              aria-label="Search alerts"
              className="w-36 rounded-lg border border-border-base bg-surface px-2.5 py-2 text-xs"
            />
          </div>
        }
      />

      {visible.length === 0 ? (
        <EmptyState
          title={showOpen ? "No open alerts" : "Nothing resolved in the log"}
          description={
            showOpen
              ? "Every channel is reading OK and no limits are being exceeded."
              : "Resolved alerts appear here once a frame arrives without the condition."
          }
        />
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-border-base text-left">
                {["Severity", "Device", "Alert", "Raised", "State", ""].map((heading, index) => (
                  <th
                    key={heading || index}
                    scope="col"
                    className="px-4 py-2 text-[11px] font-medium tracking-wide text-muted uppercase"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((alert) => (
                <tr key={alert.id} className="border-b border-border-base last:border-0">
                  <td className="px-4 py-2.5">
                    <SeverityBadge severity={alert.severity} />
                  </td>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/devices/${alert.deviceId}`}
                      className="font-medium hover:text-accent"
                    >
                      {alert.deviceName}
                    </Link>
                    {alert.channelId ? (
                      <p className="font-mono mt-0.5 text-[11px] text-muted">{alert.channelId}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <p>{alert.message}</p>
                    <p className="font-mono mt-0.5 text-[11px] text-muted">{alert.code}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="tabular">{formatAge(now - alert.raisedAt)}</span>
                    <p className="mt-0.5 text-[11px] text-muted">{formatDateTime(alert.raisedAt)}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    {alert.clearedAt ? (
                      <Badge tone="ok">Cleared</Badge>
                    ) : alert.acknowledgedAt ? (
                      <Badge tone="neutral">Acknowledged</Badge>
                    ) : (
                      <Badge tone="warn">Open</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {!alert.clearedAt && !alert.acknowledgedAt ? (
                      <button
                        type="button"
                        onClick={() => acknowledge(alert)}
                        disabled={busy === alert.id}
                        className="rounded-lg border border-border-base px-2 py-1 text-[11px] font-medium hover:border-accent/50 disabled:opacity-50"
                      >
                        {busy === alert.id ? "…" : "Acknowledge"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
