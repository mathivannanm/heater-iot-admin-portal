"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-danger/40 bg-surface px-6 py-10 text-center">
      <h1 className="text-base font-semibold text-danger">Dashboard failed to render</h1>
      <p className="mt-1 text-sm text-muted">{error.message}</p>
      {error.digest ? (
        <p className="mt-1 font-mono text-[11px] text-muted">digest: {error.digest}</p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium"
      >
        Try again
      </button>
    </div>
  );
}
