-- 006: temperature / humidity sensor boards
--
-- The TEMP-HUM Ver1 board carries four temperature probes and two humidity
-- sensors and has no relays. It registers and posts telemetry through the same
-- two endpoints as the heater, so its frames land in `telemetry` like any
-- other; what it needs on top is somewhere to keep the fields the heater never
-- sends, a way to tell the two kinds of board apart, and its own thresholds.
--
-- `devices.device_type` defaults to 'heater', so every existing row and every
-- board that never mentions a type keeps behaving exactly as before. A board
-- is a sensor when its model is "TEMP-HUM Ver1" or a frame says
-- deviceType "temphum"; the column is what makes the second case stick.
--
-- Sensor alerts get their own table rather than sharing `alerts`: the heater's
-- alert evaluation clears anything open that a frame did not re-assert, and
-- the fleet counters and the Alerts page count that table, so mixing the two
-- would change what the heater pages show.
--
-- Everything here is additive. Safe to re-run.

BEGIN;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS device_type text DEFAULT 'heater'::text NOT NULL;

UPDATE public.devices
   SET device_type = 'temphum'
 WHERE lower(btrim(model)) = 'temp-hum ver1' AND device_type <> 'temphum';

ALTER TABLE public.telemetry
  ADD COLUMN IF NOT EXISTS dht_2_temp_c numeric(6,2),
  ADD COLUMN IF NOT EXISTS sensors_ok   smallint,
  ADD COLUMN IF NOT EXISTS device_type  text;

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
    t.avg_temp_c,
    t.dht_2_temp_c,
    t.sensors_ok,
    d.device_type
   FROM ((public.devices d
     LEFT JOIN public.rooms r ON ((r.id = d.room_id)))
     LEFT JOIN public.telemetry t ON ((t.id = d.latest_telemetry_id)));

-- Thresholds are nullable: NULL means "no limit set", which is different from
-- a limit of zero. `labels` maps a sensor key (t1-t4, h1, h2) to the name the
-- operator gave it.
CREATE TABLE IF NOT EXISTS public.sensor_settings (
    device_id          uuid NOT NULL,
    temp_high_c        numeric(6,2),
    temp_low_c         numeric(6,2),
    humidity_high_pct  numeric(5,2),
    humidity_low_pct   numeric(5,2),
    labels             jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at         timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sensor_settings_pkey PRIMARY KEY (device_id),
    CONSTRAINT sensor_settings_device_id_fkey
      FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.sensor_alerts (
    id          uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id   uuid NOT NULL,
    sensor      text NOT NULL,
    kind        text NOT NULL,
    message     text NOT NULL,
    value       numeric(6,2),
    threshold   numeric(6,2),
    raised_at   timestamp with time zone DEFAULT now() NOT NULL,
    cleared_at  timestamp with time zone,
    CONSTRAINT sensor_alerts_pkey PRIMARY KEY (id),
    CONSTRAINT sensor_alerts_device_id_fkey
      FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE,
    CONSTRAINT sensor_alerts_sensor_check
      CHECK (sensor = ANY (ARRAY['t1','t2','t3','t4','h1','h2'])),
    CONSTRAINT sensor_alerts_kind_check
      CHECK (kind = ANY (ARRAY['temp_high','temp_low','humidity_high','humidity_low']))
);

CREATE INDEX IF NOT EXISTS sensor_alerts_device_idx
  ON public.sensor_alerts USING btree (device_id, raised_at DESC);

-- One open alert per sensor and condition, so a reading that stays out of
-- range for an hour is one row whose raised_at is when it started.
CREATE UNIQUE INDEX IF NOT EXISTS sensor_alerts_open_idx
  ON public.sensor_alerts USING btree (device_id, sensor, kind)
  WHERE (cleared_at IS NULL);

COMMIT;
