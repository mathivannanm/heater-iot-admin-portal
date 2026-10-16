import { FleetSummary } from "@/components/fleet-summary";
import {
  ActivityFeed,
  ChannelWall,
  FaultBreakdown,
  HeatDistribution,
  NeedsAttention,
  RoomBreakdown,
} from "@/components/overview-panels";

export const metadata = {
  title: "Overview · HEATER Ver1",
};

/**
 * The overview.
 *
 * Ordered by how urgently an operator needs each thing: the counters, then what
 * is wrong and what is happening, then the distributions you read when nothing
 * is wrong. Every panel is a client component reading the same live mirror, so
 * the whole page moves together as telemetry arrives.
 */
export default function OverviewPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Fleet overview</h1>
        <p className="mt-0.5 text-sm text-muted">
          Live state of every HEATER Ver1 board reporting to this backend.
        </p>
      </header>

      <FleetSummary />

      <div className="grid gap-4 xl:grid-cols-2">
        <NeedsAttention />
        <ActivityFeed />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <HeatDistribution />
        <FaultBreakdown />
        <RoomBreakdown />
      </div>

      <ChannelWall />
    </div>
  );
}
