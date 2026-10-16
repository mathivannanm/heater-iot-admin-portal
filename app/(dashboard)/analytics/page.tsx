import Link from "next/link";
import { AnalyticsView, type AnalyticsData } from "@/components/analytics-view";
import { cx } from "@/components/ui/primitives";
import { DAY_MS, HOUR_MS, windowEndingNow } from "@/lib/clock";
import {
  getAlertCounts,
  getEnergyByDevice,
  getEnergyByKind,
  getFleetEnergy,
  getTemperatureHistory,
} from "@/lib/store";

export const metadata = {
  title: "Analytics · HEATER Ver1",
};

export const dynamic = "force-dynamic";

const RANGES = {
  "24h": { label: "Last 24 hours", ms: 24 * HOUR_MS },
  "7d": { label: "Last 7 days", ms: 7 * DAY_MS },
  "30d": { label: "Last 30 days", ms: 30 * DAY_MS },
} as const;

type RangeKey = keyof typeof RANGES;

/**
 * Fleet-wide historical analysis.
 *
 * Rendered on the server because these are aggregate queries over the whole
 * history: pushing them through the live stream would mean recomputing a month
 * of rollups on every telemetry frame.
 */
export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  const params = await searchParams;
  const requested = Array.isArray(params.range) ? params.range[0] : params.range;
  const key: RangeKey = requested === "7d" || requested === "30d" ? requested : "24h";

  const { from, to } = windowEndingNow(RANGES[key].ms);

  const [energy, byDevice, byKind, alertCounts, temperature] = await Promise.all([
    getFleetEnergy(from, to),
    getEnergyByDevice(from, to),
    getEnergyByKind(from, to),
    getAlertCounts(from, to),
    getTemperatureHistory(from, to),
  ]);

  const data: AnalyticsData = {
    from,
    to,
    rangeLabel: RANGES[key].label,
    energy,
    byDevice,
    byKind,
    alertCounts,
    temperature,
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Analytics</h1>
          <p className="mt-0.5 text-sm text-muted">
            Historical energy, temperature and fault patterns across the fleet.
          </p>
        </div>
        <nav className="flex gap-1">
          {(Object.keys(RANGES) as RangeKey[]).map((option) => (
            <Link
              key={option}
              href={`/analytics?range=${option}`}
              aria-current={key === option ? "page" : undefined}
              className={cx(
                "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                key === option
                  ? "bg-accent-soft text-accent"
                  : "text-muted-strong hover:bg-surface-muted",
              )}
            >
              {RANGES[option].label}
            </Link>
          ))}
        </nav>
      </header>

      <AnalyticsView data={data} />
    </div>
  );
}
