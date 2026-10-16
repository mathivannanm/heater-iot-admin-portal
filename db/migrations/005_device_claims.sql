-- 005: add-from-the-website device provisioning
--
-- Every board runs the same firmware image and identifies itself by a serial
-- derived from its ESP32 MAC (HTR-XXXXXX). An operator adds the device on the
-- portal first; the board then claims that row over POST /api/devices/claim
-- and receives its device key. Until it does, devices.device_key_hash stays
-- NULL and the dashboard shows the device as "waiting for board".
--
-- A board that claims a serial nobody has added yet is remembered here so the
-- Add device form can offer it with one click instead of asking the operator
-- to copy the serial off a serial monitor.
--
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.device_claim_requests (
    serial_number text NOT NULL,
    model text,
    firmware_version text,
    bluetooth_name text,
    home_ssid text,
    local_address text,
    ip text,
    attempts integer DEFAULT 1 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_claim_requests_pkey PRIMARY KEY (serial_number)
);

COMMIT;
