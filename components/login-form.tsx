"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardHeader } from "./ui/primitives";

/**
 * Verifies the admin key against `POST /api/auth/login`, which sets the
 * `heater_admin` cookie every admin API route and the dashboard layout check.
 * A wrong key never reaches the browser as anything but a 401 here - the
 * cookie route does the real comparison, constant-time, against
 * HEATER_ADMIN_KEY.
 */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (key.trim() === "") return;

    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Sign-in failed (${response.status})`);
      }
      router.replace(next);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader
        title="Sign in"
        description="Enter the admin key (HEATER_ADMIN_KEY) to use the dashboard."
      />
      <form onSubmit={submit} className="space-y-3 px-4 py-4 sm:px-5">
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-muted-strong">Admin key</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-sm"
          />
        </label>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={sending || key.trim() === ""}
          className="w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {sending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Card>
  );
}
