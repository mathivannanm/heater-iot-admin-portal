import { FirmwareView } from "@/components/firmware-view";
import { listFirmwareReleases } from "@/lib/firmware";

export const metadata = {
  title: "Firmware · HEATER Ver1",
};

export const dynamic = "force-dynamic";

/**
 * The firmware update module: upload an image, publish it, mark one version
 * current per model, and roll it out to the fleet. Adoption figures come from
 * the live device stream, so they move as boards report their new version.
 */
export default async function FirmwarePage() {
  const releases = await listFirmwareReleases();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Firmware</h1>
        <p className="mt-0.5 text-sm text-muted">
          Upload a .bin, publish it, and choose the version the fleet should run. Devices pick up
          a roll-out on their next round trip and report back the version they are actually on.
        </p>
      </header>

      <FirmwareView initial={releases} />
    </div>
  );
}
