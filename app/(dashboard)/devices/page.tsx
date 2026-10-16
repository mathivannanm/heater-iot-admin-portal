import { AddDevice } from "@/components/add-device";
import { DeviceTable } from "@/components/device-table";
import { listRooms } from "@/lib/store";

export const metadata = {
  title: "Devices · HEATER Ver1",
};

export const dynamic = "force-dynamic";

/**
 * The device index.
 *
 * The filter state arrives in the query string so the summary tiles on the
 * overview can deep-link into a pre-filtered view, and so an operator can share
 * a link to exactly what they were looking at. Rooms come from the database
 * rather than a hard-coded list, because rooms are the operator's own.
 */
export default async function DevicesPage({ searchParams }: PageProps<"/devices">) {
  const params = await searchParams;
  const rooms = await listRooms();

  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Devices</h1>
          <p className="mt-0.5 text-sm text-muted">
            Search, filter and sort the fleet. Rows update in place as telemetry arrives.
          </p>
        </div>
        <AddDevice rooms={rooms.map((room) => ({ id: room.id, name: room.name }))} />
      </header>

      <DeviceTable
        initialStatus={(first(params.status) as never) ?? "all"}
        initialConnection={(first(params.connection) as never) ?? "all"}
        initialSort={(first(params.sortBy) as never) ?? "name"}
        initialSortDir={first(params.sortDir) === "desc" ? "desc" : "asc"}
        initialRoom={first(params.room) ?? ""}
        rooms={rooms}
      />
    </div>
  );
}
