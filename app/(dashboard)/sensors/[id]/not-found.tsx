import Link from "next/link";

export default function SensorNotFound() {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-border-base bg-surface px-6 py-10 text-center">
      <h1 className="text-base font-semibold">Sensor not found</h1>
      <p className="mt-1 text-sm text-muted">
        This is not a registered temperature / humidity sensor, or it has been decommissioned.
      </p>
      <Link
        href="/sensors"
        className="mt-4 inline-block rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium"
      >
        Back to sensors
      </Link>
    </div>
  );
}
