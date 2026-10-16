-- 007: who owns a device's name
--
-- A board sends its own name (PORTAL_NAME + "_" + chip id in the HEATER Ver1
-- firmware) when it registers and, from fw 1.8.5, in every telemetry frame as
-- `deviceName`. While `name_source` is 'device' the portal follows that name,
-- so changing it in the Arduino code shows up without touching the portal.
-- Renaming a device on the portal sets 'portal', and from then on the board's
-- name is ignored until an operator hands it back (PATCH nameSource "device").
--
-- Every existing row starts as 'device'; the one heater renamed on the portal
-- before this column existed ("Hall Heater") is marked 'portal' so it keeps
-- its name. Safe to re-run.

BEGIN;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS name_source text DEFAULT 'device'::text NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_name_source_check') THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_name_source_check CHECK (name_source IN ('device', 'portal'));
  END IF;
END $$;

UPDATE public.devices
   SET name_source = 'portal'
 WHERE serial_number = 'HTR-VER1-1784B4' AND name = 'Hall Heater';

COMMIT;
