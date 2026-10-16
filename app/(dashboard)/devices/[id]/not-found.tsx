import Link from "next/link";

export default function DeviceNotFound() {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-border-base bg-surface px-6 py-10 text-center">
      <h1 className="text-base font-semibold">Device not found</h1>
      <p className="mt-1 text-sm text-muted">
        This heater is not registered, or it has been decommissioned.
      </p>
      <Link
        href="/devices"
        className="mt-4 inline-block rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium"
      >
        Back to devices
      </Link>
    </div>
  );
}
