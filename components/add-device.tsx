"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNow } from "./live-store";
import { Badge, cx } from "./ui/primitives";
import { formatAge } from "@/lib/format";
import type { ClaimRequest, DeviceView } from "@/lib/types";

/**
 * "Add device" for the same-firmware-on-every-board flow.
 *
 * The operator types (or picks) the serial printed by the board - HTR-XXXXXX,
 * derived from its MAC - gives it a name and a room, and the row is created
 * unpaired. When the board next reaches the server it claims that row and
 * receives its key. Boards that have already tried to claim an unknown serial
 * are listed here so the serial can be adopted with one click.
 */
export function AddDevice({
  rooms,
}: {
  rooms: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const now = useNow();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [serial, setSerial] = useState("");
  const [roomId, setRoomId] = useState("");
  const [model, setModel] = useState("HEATER Ver1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<DeviceView | null>(null);
  const [waiting, setWaiting] = useState<ClaimRequest[]>([]);

  const loadWaiting = useCallback(async () => {
    try {
      const response = await fetch("/api/devices/claim", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { requests: ClaimRequest[] };
      setWaiting(payload.requests);
    } catch {
      // The list is a convenience; the form works without it.
    }
  }, []);

  // Keep the native dialog in step with React state, and poll for boards
  // while it is open so a board powered on mid-form shows up by itself.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void loadWaiting(), 5_000);
    return () => clearInterval(timer);
  }, [open, loadWaiting]);

  const show = () => {
    setOpen(true);
    void loadWaiting();
  };

  const reset = () => {
    setName("");
    setSerial("");
    setRoomId("");
    setModel("HEATER Ver1");
    setError(null);
    setAdded(null);
    setBusy(false);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const adopt = (request: ClaimRequest) => {
    setSerial(request.serialNumber);
    if (request.model) setModel(request.model);
    if (!name.trim()) setName(`Heater ${request.serialNumber.replace(/^HTR-/, "")}`);
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/devices/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          serialNumber: serial.trim().toUpperCase(),
          roomId: roomId || null,
          model: model.trim() || null,
        }),
      });
      const payload = (await response.json()) as { device?: DeviceView; error?: string };
      if (!response.ok || !payload.device) {
        setError(payload.error ?? `Request failed (${response.status})`);
        return;
      }
      setAdded(payload.device);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (request: ClaimRequest) => {
    await fetch(`/api/devices/claim?serial=${encodeURIComponent(request.serialNumber)}`, {
      method: "DELETE",
    });
    void loadWaiting();
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
      >
        Add device
      </button>

      <dialog
        ref={dialogRef}
        onClose={close}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        className="w-[min(92vw,34rem)] rounded-xl border border-border-base bg-surface p-0 text-foreground shadow-[var(--shadow-card)] backdrop:bg-black/40"
      >
        <form onSubmit={submit} className="flex flex-col">
          <header className="border-b border-border-base px-5 py-3.5">
            <h2 className="text-sm font-semibold tracking-tight">Add device</h2>
            <p className="mt-0.5 text-xs text-muted">
              Enter the serial the board prints at boot (HTR-XXXXXX). The board pairs itself the
              next time it reaches this server.
            </p>
          </header>

          {added ? (
            <div className="space-y-3 px-5 py-4 text-sm">
              <p>
                <span className="font-medium">{added.name}</span> added with serial{" "}
                <span className="font-mono text-[13px]">{added.serialNumber}</span>.
              </p>
              <p className="text-xs text-muted">
                Power the board on with Wi-Fi configured. It will show as{" "}
                <Badge tone="warn">Waiting for board</Badge> until it claims this row, then go online
                on its own.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg border border-border-base px-3 py-2 text-xs font-medium hover:border-accent/50"
                >
                  Add another
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              {waiting.length > 0 ? (
                <div className="border-b border-border-base bg-warn-soft/40 px-5 py-3">
                  <p className="text-[11px] font-medium tracking-wide text-muted uppercase">
                    Boards waiting to join
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {waiting.map((request) => (
                      <li key={request.serialNumber} className="flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => adopt(request)}
                          className={cx(
                            "rounded-md border px-2 py-1 font-mono text-[12px] hover:border-accent",
                            serial.toUpperCase() === request.serialNumber
                              ? "border-accent bg-accent-soft text-accent"
                              : "border-border-base bg-surface",
                          )}
                          title="Use this serial"
                        >
                          {request.serialNumber}
                        </button>
                        <span className="min-w-0 truncate text-muted">
                          {[request.model, request.ip, `seen ${formatAge(now - request.lastSeenAt)}`]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        <button
                          type="button"
                          onClick={() => void dismiss(request)}
                          className="ml-auto text-muted hover:text-danger"
                          aria-label={`Forget ${request.serialNumber}`}
                          title="Forget this board"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="grid gap-3 px-5 py-4">
                <Input
                  label="Serial number"
                  value={serial}
                  onChange={setSerial}
                  placeholder="HTR-A1B2C3"
                  mono
                  required
                  autoFocus
                  hint="Printed on the serial monitor at boot, or send the command “id” over Serial / Bluetooth."
                />
                <Input
                  label="Name"
                  value={name}
                  onChange={setName}
                  placeholder="Living Room Heater"
                  required
                />
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs">
                    <span className="text-[11px] font-medium tracking-wide text-muted uppercase">Room</span>
                    <select
                      value={roomId}
                      onChange={(event) => setRoomId(event.target.value)}
                      className="mt-1 block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-xs"
                    >
                      <option value="">Unassigned</option>
                      {rooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Input label="Model" value={model} onChange={setModel} placeholder="HEATER Ver1" />
                </div>

                {error ? <p className="text-xs text-danger">{error}</p> : null}
              </div>

              <footer className="flex items-center justify-end gap-2 border-t border-border-base px-5 py-3">
                <button
                  type="button"
                  onClick={close}
                  className="rounded-lg border border-border-base px-3 py-2 text-xs font-medium hover:border-accent/50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !serial.trim() || !name.trim()}
                  className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? "Adding…" : "Add device"}
                </button>
              </footer>
            </>
          )}
        </form>
      </dialog>
    </>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono = false,
  required = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="block text-xs">
      <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        className={cx(
          "mt-1 block w-full rounded-lg border border-border-base bg-surface px-2.5 py-2 text-sm placeholder:text-muted",
          mono && "font-mono text-[13px] uppercase",
        )}
      />
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}
