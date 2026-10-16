-- 004: fourth temperature probe and board-reported average
--
-- The Fan Temp Monitor board carries four DS18B20 probes on one bus (one per
-- room corner) and reports temp1C-temp4C plus its own avgTempC and maxTempC.
-- Until now the fourth probe and the average survived only inside `raw`, so
-- the dashboard could neither show nor chart them.
--
-- Both columns are nullable: the HEATER Ver1 board has three probes and sends
-- neither, and keeps working unchanged. avg_temp_c is stored as the board
-- reported it rather than recomputed here, so what the device displayed and
-- what the dashboard shows cannot disagree.
--
-- Safe to re-run.

BEGIN;

ALTER TABLE public.telemetry
  ADD COLUMN IF NOT EXISTS temp_4_c   numeric(6,2),
  ADD COLUMN IF NOT EXISTS avg_temp_c numeric(6,2);

-- CREATE OR REPLACE VIEW may only append columns, so these go at the end.
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
    t.ble_rssi_dbm,
    t.temp_4_c,
    t.avg_temp_c
   FROM ((public.devices d
     LEFT JOIN public.rooms r ON ((r.id = d.room_id)))
     LEFT JOIN public.telemetry t ON ((t.id = d.latest_telemetry_id)));

COMMIT;
