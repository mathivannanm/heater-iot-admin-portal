"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { StreamIndicator } from "./fleet-summary";
import { cx } from "./ui/primitives";
import { DISPLAY_TIME_ZONE, formatDuration } from "@/lib/format";

/** Application chrome: brand, primary navigation and the live-stream badge. */

const NAV = [
  { href: "/", label: "Overview", exact: true },
  { href: "/devices", label: "Devices", exact: false },
  { href: "/sensors", label: "Temperature & Humidity", exact: false },
  { href: "/alerts", label: "Alerts", exact: false },
  { href: "/analytics", label: "Analytics", exact: false },
  { href: "/firmware", label: "Firmware", exact: false },
];

function NavLinks({ onNavigate, vertical }: { onNavigate?: () => void; vertical?: boolean }) {
  const pathname = usePathname();

  return (
    <nav className={cx("flex gap-1", vertical ? "flex-col" : "flex-row")}>
      {NAV.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cx(
              "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent-soft text-accent"
                : "text-muted-strong hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Shell({
  children,
  thresholds,
  adminAuthConfigured,
}: {
  children: React.ReactNode;
  thresholds: { telemetryIntervalMs: number; offlineTimeoutMs: number; staleDataMs: number };
  adminAuthConfigured: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-1 flex-col lg:flex-row">
      {/* Brand rule: the one piece of solid red that is always on screen. */}
      <div aria-hidden className="fixed inset-x-0 top-0 z-30 h-[3px] bg-accent" />
      {/* Sidebar: persistent from lg upward, collapsed into the header below it. */}
      <aside className="hidden w-60 shrink-0 border-r border-border-base bg-surface lg:flex lg:flex-col">
        <div className="px-4 pt-6 pb-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-accent text-white">
              <FlameGlyph />
            </span>
            <span>
              <span className="block text-sm font-semibold leading-tight">HEATER Ver1</span>
              <span className="block text-[11px] text-muted">Fleet monitoring</span>
            </span>
          </Link>
        </div>

        <div className="px-3">
          <NavLinks vertical />
        </div>

        <div className="mt-auto space-y-1.5 border-t border-border-base px-4 py-4 text-[11px] text-muted">
          <p className="font-medium text-muted-strong">Monitoring thresholds</p>
          <p>Telemetry every {formatDuration(thresholds.telemetryIntervalMs)}</p>
          <p>Offline after {formatDuration(thresholds.offlineTimeoutMs)} of silence</p>
          <p>Data flagged stale after {formatDuration(thresholds.staleDataMs)}</p>
          <p className="pt-1">Times shown in {DISPLAY_TIME_ZONE}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-border-base bg-surface/85 backdrop-blur">
          <div className="flex items-center gap-3 px-4 pt-3.5 pb-3 sm:px-6">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-label="Toggle navigation"
              className="rounded-lg border border-border-base p-2 lg:hidden"
            >
              <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
                <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>

            <Link href="/" className="flex items-center gap-2 lg:hidden">
              <span className="grid size-7 place-items-center rounded-lg bg-accent text-white">
                <FlameGlyph />
              </span>
              <span className="text-sm font-semibold">HEATER Ver1</span>
            </Link>

            <div className="ml-auto flex items-center gap-3">
              <StreamIndicator />
              {adminAuthConfigured ? <SignOutButton /> : null}
            </div>
          </div>

          {menuOpen ? (
            <div className="border-t border-border-base px-3 py-2 lg:hidden">
              <NavLinks onNavigate={() => setMenuOpen(false)} />
            </div>
          ) : null}
        </header>

        {!adminAuthConfigured ? (
          <p className="border-b border-warn/30 bg-warn-soft px-4 py-2 text-xs text-warn sm:px-6">
            <strong className="font-semibold">Admin API is unauthenticated.</strong> Set{" "}
            <code className="font-mono">HEATER_ADMIN_KEY</code> before exposing this dashboard
            beyond localhost.
          </p>
        ) : null}

        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-6">{children}</main>
      </div>
    </div>
  );
}

/**
 * Reaching the Shell at all already proved the browser holds a valid
 * `heater_admin` cookie - the layout redirects to /login otherwise - so this
 * only ever needs to offer signing out, not in.
 */
function SignOutButton() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={signingOut}
      className="rounded-lg border border-border-base px-2.5 py-1.5 text-xs font-medium text-muted-strong hover:border-accent/50 hover:text-foreground disabled:opacity-50"
    >
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  );
}

function FlameGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
      <path
        d="M8 1.5s3.5 3 3.5 6a3.5 3.5 0 1 1-7 0c0-1.2.6-2.2 1.2-3 .1 1 .6 1.6 1.2 1.6.9 0 1.1-1.3 1.1-4.6Z"
        fill="currentColor"
      />
    </svg>
  );
}
