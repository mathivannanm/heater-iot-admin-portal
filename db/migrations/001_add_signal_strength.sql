-- 001: signal strength (Wi-Fi and Bluetooth RSSI)
--
-- The dashboard has to answer "how strong is the link?", not just "is there
-- one?". RSSI is the only honest measure of that, so it is recorded per frame
-- alongside the readings it was measured with.
--
-- Both columns are nullable on purpose. Firmware that does not report RSSI
-- keeps working unchanged and the dashboard renders a dash rather than a
-- fabricated bar. Nothing here infers distance: usable range depends on the
-- antenna, the enclosure, obstacles and the phone's own radio, so only the
-- measured value and the link state are ever stored.
--
-- Safe to re-run.

BEGIN;

ALTER TABLE public.telemetry
  ADD COLUMN IF NOT EXISTS wifi_rssi_dbm smallint,
  ADD COLUMN IF NOT EXISTS ble_rssi_dbm  smallint;

-- Bounds are the physical range of a 2.4 GHz radio report, so a stuck sensor
-- or a byte-order bug is rejected at the door rather than skewing the charts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telemetry_wifi_rssi_dbm_check'
  ) THEN
    ALTER TABLE public.telemetry
      ADD CONSTRAINT telemetry_wifi_rssi_dbm_check
      CHECK (wifi_rssi_dbm IS NULL OR (wifi_rssi_dbm BETWEEN -120 AND 0));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telemetry_ble_rssi_dbm_check'
  ) THEN
    ALTER TABLE public.telemetry
      ADD CONSTRAINT telemetry_ble_rssi_dbm_check
      CHECK (ble_rssi_dbm IS NULL OR (ble_rssi_dbm BETWEEN -120 AND 0));
  END IF;
END
$$;

-- The view feeds every "current state" read in the application. CREATE OR
-- REPLACE VIEW may only append columns, which is where these two belong.
CREATE OR REPLACE VIEW public.device_latest_state AS
 SELECT d.id,
    d.home_id,
    d.room_id,
    d.name,
    d.bluetooth_name,
    d.bluetooth_address,
    d.serial_number,
    d.firmware_version,
    d.model,
    d.home_ssid,
    d.local_address,
    d.remote_address,
    d.device_key_hash,
    d.device_key_set_at,
    d.last_seen_at,
    d.latest_telemetry_id,
    d.created_at,
    d.updated_at,
    d.id AS device_id,
    r.name AS room_name,
    r.icon AS room_icon,
    t.id AS telemetry_id,
    t.recorded_at,
    t.level,
    t.level_value,
    t.mode,
    t.manual,
    t.auto_fan,
    t.tripped,
    t.climate,
    t.climate_target_c,
    t.total_current_a,
    t.sum_current_a,
    t.total_power_w,
    t.reading_source,
    t.meter_voltage_v,
    t.mains_voltage_v,
    t.temp_1_c,
    t.temp_2_c,
    t.temp_3_c,
    t.dht_temp_c,
    t.max_temp_c,
    t.humidity_1_pct,
    t.humidity_2_pct,
    t.humidity_3_pct,
    t.current_limit_a,
    t.total_limit_a,
    t.temperature_limit_c,
    t.wifi,
    t.ip,
    t.bluetooth_client,
    t.api_key_set,
    t.uptime_seconds,
    t.wifi_rssi_dbm,
    t.ble_rssi_dbm
   FROM ((public.devices d
     LEFT JOIN public.rooms r ON ((r.id = d.room_id)))
     LEFT JOIN public.telemetry t ON ((t.id = d.latest_telemetry_id)));

COMMIT;
