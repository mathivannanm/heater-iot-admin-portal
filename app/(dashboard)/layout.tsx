import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LiveProvider } from "@/components/live-store";
import { Shell } from "@/components/shell";
import { ADMIN_COOKIE_NAME, adminAuthConfigured, verifyAdminKey } from "@/lib/auth";
import { config } from "@/lib/config";
import { snapshot } from "@/lib/store";

/**
 * Reads the fleet straight out of Postgres for the first paint - the dashboard
 * is this backend's own UI, so there is no reason to make it call itself over
 * HTTP - then hands off to the SSE stream for every later update.
 */
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  // Every admin API route accepts this same cookie (lib/auth.ts), but nothing
  // set it - so a signed-out browser could still load the dashboard's first
  // paint (this layout reads Postgres directly) and then have every button,
  // filter and upload fail with 401 the moment it called the API. Gate the
  // page itself instead: no cookie, no dashboard, and the fetches behind it
  // never fire unauthenticated in the first place.
  if (adminAuthConfigured()) {
    const jar = await cookies();
    const presented = jar.get(ADMIN_COOKIE_NAME)?.value;
    if (!presented || !verifyAdminKey(presented)) redirect("/login");
  }

  const initial = await snapshot();

  const thresholds = {
    telemetryIntervalMs: config.telemetryIntervalMs,
    offlineTimeoutMs: config.offlineTimeoutMs,
    staleDataMs: config.staleDataMs,
  };

  return (
    <LiveProvider
      initialDevices={initial.devices}
      initialStats={initial.stats}
      thresholds={thresholds}
      serverNow={initial.now}
    >
      <Shell thresholds={thresholds} adminAuthConfigured={adminAuthConfigured()}>
        {children}
      </Shell>
    </LiveProvider>
  );
}
