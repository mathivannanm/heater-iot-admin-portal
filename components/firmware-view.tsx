"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { useLiveDevices, useNow } from "./live-store";
import { Badge, Card, CardHeader, EmptyState, cx, type Tone } from "./ui/primitives";
import { formatAge, formatDateTime } from "@/lib/format";
import type { FirmwareRelease, FirmwareStatus } from "@/lib/types";

/**
 * Firmware update module.
 *
 * Three ideas, kept visibly separate because operators confuse them at 2 a.m.:
 *   - a release is *uploaded* (a draft nobody outside this page can see),
 *   - it is *published* (devices may download it),
 *   - one published release per model is *current* (what the fleet should run).
 * Rolling out queues a command per device; adoption is read from what the
 * devices then report, never from what was sent.
 */

const DEFAULT_MODEL = "HEATER Ver1";

const STATUS_TONE: Record<FirmwareStatus, Tone> = {
  draft: "neutral",
  published: "wifi",
  current: "ok",
};

const STATUS_LABEL: Record<FirmwareStatus, string> = {
  draft: "Draft",
  published: "Published",
  current: "Current",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${fallback} (${response.status})`;
}

export function FirmwareView({ initial }: { initial: FirmwareRelease[] }) {
  const now = useNow();
  const devices = useLiveDevices();

  const [releases, setReleases] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/firmware", { cache: "no-store" });
    if (response.ok) {
      const body = (await response.json()) as { releases: FirmwareRelease[] };
      setReleases(body.releases);
    }
  }, []);

  // Live adoption. `deviceCount` on each release is a database snapshot from
  // page load; the stream is what moves as boards come back on a new version.
  const adoption = useMemo(() => {
    const byModel = new Map<
      string,
      { total: number; versions: Map<string, number> }
    >();
    for (const device of devices) {
      const entry = byModel.get(device.model) ?? { total: 0, versions: new Map() };
      entry.total += 1;
      const version = device.firmwareVersion ?? "unknown";
      entry.versions.set(version, (entry.versions.get(version) ?? 0) + 1);
      byModel.set(device.model, entry);
    }
    return byModel;
  }, [devices]);

  const models = useMemo(() => {
    const names = new Set<string>([DEFAULT_MODEL]);
    for (const release of releases) names.add(release.model);
    for (const model of adoption.keys()) names.add(model);
    return [...names].sort();
  }, [releases, adoption]);

  const currentFor = (model: string) => releases.find((r) => r.model === model && r.isCurrent) ?? null;
  const onVersion = (model: string, version: string) => adoption.get(model)?.versions.get(version) ?? 0;

  const act = async (
    release: FirmwareRelease,
    request: () => Promise<Response>,
    success: string,
    failure: string,
  ) => {
    setBusy(release.id);
    setNotice(null);
    try {
      const response = await request();
      if (!response.ok) throw new Error(await readError(response, failure));
      await refresh();
      setNotice({ tone: "ok", text: success });
      return (await response.json().catch(() => null)) as unknown;
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : failure });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const patch = (release: FirmwareRelease, body: Record<string, unknown>, success: string) =>
    act(
      release,
      () =>
        fetch(`/api/firmware/${release.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      success,
      "Could not update the release",
    );

  const remove = async (release: FirmwareRelease) => {
    if (!window.confirm(`Delete ${release.model} ${release.version}? This cannot be undone.`)) return;
    await act(
      release,
      () => fetch(`/api/firmware/${release.id}`, { method: "DELETE" }),
      `Deleted ${release.version}`,
      "Could not delete the release",
    );
  };

  const rollout = async (release: FirmwareRelease) => {
    const total = adoption.get(release.model)?.total ?? 0;
    const outdated = total - onVersion(release.model, release.version);
    if (outdated <= 0) {
      setNotice({ tone: "neutral", text: `Every ${release.model} device already reports ${release.version}.` });
      return;
    }
    if (
      !window.confirm(
        `Queue FIRMWARE_UPDATE ${release.version} for ${outdated} ${release.model} device${outdated === 1 ? "" : "s"}? Offline devices receive it when they reconnect.`,
      )
    ) {
      return;
    }
    const result = (await act(
      release,
      () => fetch(`/api/firmware/${release.id}/rollout`, { method: "POST" }),
      "",
      "Could not start the roll-out",
    )) as { queued?: unknown[]; alreadyCurrent?: number } | null;
    if (result) {
      setNotice({
        tone: "ok",
        text: `Queued ${release.version} for ${result.queued?.length ?? 0} device(s); ${result.alreadyCurrent ?? 0} already on it.`,
      });
    }
  };

  return (
    <div className="space-y-4">
      {notice ? (
        <p
          role="status"
          className={cx(
            "rounded-lg px-3 py-2 text-xs",
            notice.tone === "ok" && "bg-ok-soft text-ok",
            notice.tone === "danger" && "bg-danger-soft text-danger",
            notice.tone === "neutral" && "bg-idle-soft text-muted-strong",
          )}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {models.map((model) => (
          <CurrentVersionCard
            key={model}
            model={model}
            current={currentFor(model)}
            total={adoption.get(model)?.total ?? 0}
            onVersion={onVersion}
            versions={adoption.get(model)?.versions ?? new Map()}
            busy={busy}
            onRollout={rollout}
          />
        ))}
      </div>

      <UploadCard
        models={models}
        onUploaded={async (release) => {
          await refresh();
          setNotice({
            tone: "ok",
            text:
              release.status === "current"
                ? `${release.version} published and set as current for ${release.model}.`
                : release.status === "published"
                  ? `${release.version} published. Set it current when you are ready to roll it out.`
                  : `${release.version} uploaded as a draft. Publish it when it is ready for devices.`,
          });
        }}
      />

      <Card>
        <CardHeader
          title="Releases"
          description={`${releases.length} release${releases.length === 1 ? "" : "s"} · current first`}
        />
        {releases.length === 0 ? (
          <EmptyState
            title="No firmware uploaded yet"
            description="Upload a .bin above to create the first release."
          />
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border-base text-left">
                  {["Version", "Status", "Image", "Devices on it", "Uploaded", "Published", ""].map(
                    (heading, index) => (
                      <th
                        key={heading || index}
                        scope="col"
                        className="px-4 py-2 text-[11px] font-medium tracking-wide text-muted uppercase"
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {releases.map((release) => {
                  const live = onVersion(release.model, release.version);
                  const total = adoption.get(release.model)?.total ?? 0;
                  const isBusy = busy === release.id;
                  return (
                    <tr key={release.id} className="border-b border-border-base last:border-0 align-top">
                      <td className="px-4 py-2.5">
                        <p className="font-mono font-medium">{release.version}</p>
                        <p className="mt-0.5 text-[11px] text-muted">{release.model}</p>
                        {release.notes ? (
                          <p className="mt-1 max-w-xs text-xs whitespace-pre-line text-muted-strong">
                            {release.notes}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONE[release.status]}>{STATUS_LABEL[release.status]}</Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        <p className="font-mono text-[13px]">{release.filename}</p>
                        <p className="mt-0.5 text-[11px] text-muted">
                          {formatBytes(release.sizeBytes)} ·{" "}
                          <span className="font-mono" title={release.sha256}>
                            sha256 {release.sha256.slice(0, 12)}…
                          </span>
                        </p>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="tabular">{live}</span>
                        <span className="text-muted"> / {total}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="tabular">{formatAge(now - release.createdAt)}</span>
                        <p className="mt-0.5 text-[11px] text-muted">{formatDateTime(release.createdAt)}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        {release.publishedAt ? (
                          <>
                            <span className="tabular">{formatAge(now - release.publishedAt)}</span>
                            <p className="mt-0.5 text-[11px] text-muted">{formatDateTime(release.publishedAt)}</p>
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {release.status === "draft" ? (
                            <>
                              <ActionButton
                                disabled={isBusy}
                                onClick={() => patch(release, { action: "publish" }, `Published ${release.version}`)}
                              >
                                Publish
                              </ActionButton>
                              <ActionButton
                                disabled={isBusy}
                                primary
                                onClick={() =>
                                  patch(
                                    release,
                                    { action: "publish", makeCurrent: true },
                                    `${release.version} is now current for ${release.model}`,
                                  )
                                }
                              >
                                Publish &amp; make current
                              </ActionButton>
                            </>
                          ) : null}
                          {release.status === "published" ? (
                            <>
                              <ActionButton
                                disabled={isBusy}
                                primary
                                onClick={() =>
                                  patch(
                                    release,
                                    { action: "set_current" },
                                    `${release.version} is now current for ${release.model}`,
                                  )
                                }
                              >
                                Make current
                              </ActionButton>
                              <ActionButton
                                disabled={isBusy}
                                onClick={() => patch(release, { action: "unpublish" }, `Withdrew ${release.version}`)}
                              >
                                Withdraw
                              </ActionButton>
                            </>
                          ) : null}
                          {release.status !== "draft" ? (
                            <ActionButton disabled={isBusy} onClick={() => rollout(release)}>
                              Roll out
                            </ActionButton>
                          ) : null}
                          <a
                            href={`/api/firmware/${release.id}/download`}
                            className="rounded-lg border border-border-base px-2 py-1 text-[11px] font-medium hover:border-accent/50"
                          >
                            Download
                          </a>
                          {release.status !== "current" ? (
                            <ActionButton disabled={isBusy} danger onClick={() => remove(release)}>
                              Delete
                            </ActionButton>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function CurrentVersionCard({
  model,
  current,
  total,
  versions,
  onVersion,
  busy,
  onRollout,
}: {
  model: string;
  current: FirmwareRelease | null;
  total: number;
  versions: Map<string, number>;
  onVersion: (model: string, version: string) => number;
  busy: string | null;
  onRollout: (release: FirmwareRelease) => void;
}) {
  const upToDate = current ? onVersion(model, current.version) : 0;
  const outdated = total - upToDate;
  const breakdown = [...versions.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {model}
            <Badge tone="neutral">current version</Badge>
          </span>
        }
        description={`${total} device${total === 1 ? "" : "s"} in the fleet`}
        actions={
          current ? (
            <ActionButton primary disabled={busy === current.id || outdated <= 0} onClick={() => onRollout(current)}>
              {outdated > 0 ? `Roll out to ${outdated} outdated` : "Fleet up to date"}
            </ActionButton>
          ) : null
        }
      />
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-[auto_1fr] sm:px-5">
        <div>
          <p className="font-mono text-2xl font-semibold tracking-tight">
            {current ? current.version : <span className="text-muted">none</span>}
          </p>
          <p className="mt-1 text-xs text-muted">
            {current
              ? `Published ${formatDateTime(current.publishedAt)} · ${formatBytes(current.sizeBytes)}`
              : "Publish a release and mark it current to enable updates."}
          </p>
          {current ? (
            <p className="mt-2 text-sm">
              <span className="tabular font-medium">{upToDate}</span>
              <span className="text-muted"> of {total} up to date</span>
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-[11px] font-medium tracking-wide text-muted uppercase">Versions reported</p>
          {breakdown.length === 0 ? (
            <p className="mt-1 text-xs text-muted">No devices of this model are registered.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {breakdown.map(([version, count]) => {
                const share = total ? Math.round((count / total) * 100) : 0;
                const isCurrent = current?.version === version;
                return (
                  <li key={version} className="flex items-center gap-2 text-xs">
                    <span className="font-mono w-24 truncate">{version}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-idle-soft">
                      <span
                        className={cx("block h-full rounded-full", isCurrent ? "bg-ok" : "bg-warn")}
                        style={{ width: `${share}%` }}
                      />
                    </span>
                    <span className="tabular w-16 text-right text-muted">
                      {count} · {share}%
                    </span>
                    <Link
                      href={`/devices?search=${encodeURIComponent(version)}`}
                      className="text-muted hover:text-accent"
                      title="Show these devices"
                    >
                      view
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function UploadCard({
  models,
  onUploaded,
}: {
  models: string[];
  onUploaded: (release: FirmwareRelease) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"draft" | "publish" | "current">("publish");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) {
      setError("Choose a .bin file");
      return;
    }
    if (!version.trim()) {
      setError("Enter a version, e.g. 1.2.0");
      return;
    }

    const form = new FormData();
    form.set("file", file);
    form.set("version", version.trim());
    form.set("model", model);
    form.set("notes", notes);
    if (mode !== "draft") form.set("publish", "true");
    if (mode === "current") form.set("makeCurrent", "true");

    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/firmware", { method: "POST", body: form });
      if (!response.ok) throw new Error(await readError(response, "Upload failed"));
      const body = (await response.json()) as { release: FirmwareRelease };
      setFile(null);
      setVersion("");
      setNotes("");
      if (fileRef.current) fileRef.current.value = "";
      await onUploaded(body.release);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Publish a new version"
        description="Upload the compiled image. The SHA-256 is computed on the server and handed to devices for verification."
      />
      <form onSubmit={submit} className="grid gap-3 px-4 py-4 sm:px-5 md:grid-cols-[1fr_1fr]">
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-muted-strong">Firmware image (.bin)</span>
          <input
            ref={fileRef}
            type="file"
            accept=".bin,application/octet-stream"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-accent"
          />
          {file ? (
            <span className="mt-1 block text-[11px] text-muted">
              {file.name} · {formatBytes(file.size)}
            </span>
          ) : null}
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted-strong">Version</span>
            <input
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="1.2.0"
              className="font-mono block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-xs"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted-strong">Model</span>
            <input
              list="firmware-models"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-xs"
            />
            <datalist id="firmware-models">
              {models.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
        </div>

        <label className="block text-xs md:col-span-2">
          <span className="mb-1 block font-medium text-muted-strong">Release notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            placeholder="What changed, and anything an operator should know before rolling out."
            className="block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-xs"
          />
        </label>

        <fieldset className="md:col-span-2">
          <legend className="mb-1 text-xs font-medium text-muted-strong">After upload</legend>
          <div className="flex flex-wrap gap-1">
            {(
              [
                { key: "draft", label: "Keep as draft", hint: "Only visible here" },
                { key: "publish", label: "Publish", hint: "Devices may download it" },
                { key: "current", label: "Publish & make current", hint: "The version the fleet should run" },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setMode(option.key)}
                aria-pressed={mode === option.key}
                title={option.hint}
                className={cx(
                  "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                  mode === option.key ? "bg-accent-soft text-accent" : "text-muted-strong hover:bg-surface-muted",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex items-center gap-3 md:col-span-2">
          <button
            type="submit"
            disabled={sending}
            className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {sending ? "Uploading…" : "Upload"}
          </button>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      </form>
    </Card>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50",
        primary
          ? "border-accent/40 bg-accent-soft text-accent hover:border-accent"
          : danger
            ? "border-border-base text-danger hover:border-danger/50"
            : "border-border-base hover:border-accent/50",
      )}
    >
      {children}
    </button>
  );
}
