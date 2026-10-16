import { AlertsView } from "@/components/alerts-view";
import { listAlerts } from "@/lib/store";

export const metadata = {
  title: "Alerts · HEATER Ver1",
};

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const alerts = await listAlerts({ open: true, limit: 200 });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Alerts</h1>
        <p className="mt-0.5 text-sm text-muted">
          Raised from ingested telemetry against each device&apos;s protection limits, and cleared
          when the condition stops appearing.
        </p>
      </header>

      <AlertsView initial={alerts} />
    </div>
  );
}
