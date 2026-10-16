--
-- HEATER Ver1 — `heaterfan` database schema
--
-- The complete structure the application expects. Generated with pg_dump
-- --schema-only and checked in so the database can be recreated on any
-- machine; without it the app is only runnable where the database happens to
-- already exist.
--
--   createdb heaterfan
--   node scripts/db.mjs setup      -- apply this file to the empty database
--   node scripts/db.mjs migrate    -- bring an existing database up to date
--   node scripts/db.mjs status     -- show applied vs pending migrations
--
-- Regenerate after a migration with:
--   pg_dump --schema-only --no-owner --no-privileges --no-comments \
--     --dbname="$DATABASE_URL" > db/schema.sql
--

--
-- PostgreSQL database dump
--

\restrict xhesnPrJAqzvxbvXY4bHhnWDPVBWynhkcZsujzjAyWG3uFIZ9mQhp0ycYfiNTYi

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: alert_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alert_severity AS ENUM (
    'info',
    'warning',
    'critical'
);


--
-- Name: channel_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.channel_kind AS ENUM (
    'heater',
    'fan',
    'light'
);


--
-- Name: command_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.command_status AS ENUM (
    'pending',
    'delivered',
    'acked',
    'failed',
    'expired'
);


--
-- Name: fault_code; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.fault_code AS ENUM (
    'ok',
    'over_current',
    'no_load',
    'over_temperature'
);


--
-- Name: heat_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.heat_level AS ENUM (
    'off',
    'low',
    'medium',
    'high'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'owner',
    'member',
    'viewer'
);


--
-- Name: wifi_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.wifi_mode AS ENUM (
    'AP',
    'STA'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    channel_index smallint,
    channel_id text,
    code text NOT NULL,
    severity public.alert_severity DEFAULT 'warning'::public.alert_severity NOT NULL,
    message text NOT NULL,
    value numeric(10,3),
    raised_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid
);


--
-- Name: api_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_requests (
    id bigint NOT NULL,
    method text NOT NULL,
    route text NOT NULL,
    path text NOT NULL,
    query text,
    status smallint NOT NULL,
    duration_ms integer NOT NULL,
    credential text NOT NULL,
    device_id uuid,
    ip inet,
    user_agent text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_requests_status_check CHECK (((status >= 100) AND (status <= 599)))
);


--
-- Name: api_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_requests_id_seq OWNED BY public.api_requests.id;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    user_id uuid,
    device_id uuid,
    action text NOT NULL,
    detail jsonb,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    issued_by uuid,
    command text NOT NULL,
    status public.command_status DEFAULT 'pending'::public.command_status NOT NULL,
    reply text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '00:02:00'::interval) NOT NULL
);


--
-- Name: device_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    channel_index smallint NOT NULL,
    channel_id text NOT NULL,
    name text NOT NULL,
    kind public.channel_kind NOT NULL,
    relay_pin smallint,
    ct_pin smallint,
    calibration numeric(8,2) DEFAULT 1.00 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_channels_channel_index_check CHECK (((channel_index >= 0) AND (channel_index <= 5)))
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    home_id uuid NOT NULL,
    room_id uuid,
    name text DEFAULT 'Heater'::text NOT NULL,
    bluetooth_name text DEFAULT 'HEATER_VER1'::text NOT NULL,
    bluetooth_address text,
    serial_number text,
    firmware_version text,
    model text DEFAULT 'HEATER Ver1'::text NOT NULL,
    home_ssid text,
    local_address text,
    remote_address text,
    device_key_hash text,
    device_key_set_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    latest_telemetry_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_type text DEFAULT 'heater'::text NOT NULL,
    name_source text DEFAULT 'device'::text NOT NULL,
    CONSTRAINT devices_name_source_check CHECK ((name_source = ANY (ARRAY['device'::text, 'portal'::text])))
);


--
-- Name: device_claim_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_claim_requests (
    serial_number text NOT NULL,
    model text,
    firmware_version text,
    bluetooth_name text,
    home_ssid text,
    local_address text,
    ip text,
    attempts integer DEFAULT 1 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    home_id uuid NOT NULL,
    name text NOT NULL,
    icon text DEFAULT 'room'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telemetry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telemetry (
    id bigint NOT NULL,
    device_id uuid NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    level public.heat_level DEFAULT 'off'::public.heat_level NOT NULL,
    level_value smallint DEFAULT 0 NOT NULL,
    mode text DEFAULT 'OFF'::text NOT NULL,
    manual boolean DEFAULT false NOT NULL,
    auto_fan boolean DEFAULT true NOT NULL,
    tripped boolean DEFAULT false NOT NULL,
    climate boolean DEFAULT false NOT NULL,
    climate_target_c numeric(4,1),
    total_current_a numeric(8,3) DEFAULT 0 NOT NULL,
    sum_current_a numeric(8,3) DEFAULT 0 NOT NULL,
    total_power_w numeric(10,2) DEFAULT 0 NOT NULL,
    reading_source text DEFAULT 'CT SUM'::text NOT NULL,
    meter_voltage_v numeric(6,2) DEFAULT 0 NOT NULL,
    mains_voltage_v numeric(6,2) DEFAULT 230 NOT NULL,
    temp_1_c numeric(6,2),
    temp_2_c numeric(6,2),
    temp_3_c numeric(6,2),
    dht_temp_c numeric(6,2),
    max_temp_c numeric(6,2),
    humidity_1_pct numeric(5,2),
    humidity_2_pct numeric(5,2),
    humidity_3_pct numeric(5,2),
    current_limit_a numeric(6,2),
    total_limit_a numeric(6,2),
    temperature_limit_c numeric(6,2),
    wifi public.wifi_mode DEFAULT 'AP'::public.wifi_mode NOT NULL,
    ip inet,
    bluetooth_client boolean DEFAULT false NOT NULL,
    api_key_set boolean DEFAULT false NOT NULL,
    uptime_seconds integer DEFAULT 0 NOT NULL,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    wifi_rssi_dbm smallint,
    ble_rssi_dbm smallint,
    temp_4_c numeric(6,2),
    avg_temp_c numeric(6,2),
    dht_2_temp_c numeric(6,2),
    sensors_ok smallint,
    device_type text,
    CONSTRAINT telemetry_ble_rssi_dbm_check CHECK (((ble_rssi_dbm IS NULL) OR ((ble_rssi_dbm >= '-120'::integer) AND (ble_rssi_dbm <= 0)))),
    CONSTRAINT telemetry_wifi_rssi_dbm_check CHECK (((wifi_rssi_dbm IS NULL) OR ((wifi_rssi_dbm >= '-120'::integer) AND (wifi_rssi_dbm <= 0))))
);


--
-- Name: device_latest_state; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.device_latest_state AS
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


--
-- Name: device_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_settings (
    device_id uuid NOT NULL,
    current_limit_a numeric(6,2) DEFAULT 12.0 NOT NULL,
    total_limit_a numeric(6,2) DEFAULT 30.0 NOT NULL,
    temperature_limit_c numeric(6,2) DEFAULT 85.0 NOT NULL,
    mains_voltage_v numeric(6,2) DEFAULT 230.0 NOT NULL,
    auto_fan boolean DEFAULT true NOT NULL,
    climate_enabled boolean DEFAULT false NOT NULL,
    climate_target_c numeric(4,1) DEFAULT 21.0 NOT NULL,
    ir_slots jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT device_settings_climate_target_c_check CHECK (((climate_target_c >= 10.0) AND (climate_target_c <= 35.0)))
);


--
-- Name: energy_hourly; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.energy_hourly (
    device_id uuid NOT NULL,
    channel_index smallint NOT NULL,
    bucket timestamp with time zone NOT NULL,
    channel_id text NOT NULL,
    energy_wh numeric(14,3) DEFAULT 0 NOT NULL,
    avg_power_w numeric(10,2) DEFAULT 0 NOT NULL,
    peak_power_w numeric(10,2) DEFAULT 0 NOT NULL,
    on_samples integer DEFAULT 0 NOT NULL,
    samples integer DEFAULT 0 NOT NULL
);


--
-- Name: home_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.home_members (
    home_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.user_role DEFAULT 'member'::public.user_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: firmware_releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.firmware_releases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    model text DEFAULT 'HEATER Ver1'::text NOT NULL,
    version text NOT NULL,
    filename text NOT NULL,
    size_bytes integer NOT NULL,
    sha256 text NOT NULL,
    notes text,
    image bytea NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT firmware_releases_current_published_check CHECK (((NOT is_current) OR (published_at IS NOT NULL))),
    CONSTRAINT firmware_releases_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT firmware_releases_size_check CHECK ((size_bytes > 0))
);


--
-- Name: homes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.homes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    name text DEFAULT 'My home'::text NOT NULL,
    location_label text,
    latitude double precision,
    longitude double precision,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    user_agent text,
    ip inet,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telemetry_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telemetry_channels (
    telemetry_id bigint NOT NULL,
    device_id uuid NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    channel_index smallint NOT NULL,
    channel_id text NOT NULL,
    is_on boolean DEFAULT false NOT NULL,
    current_a numeric(8,3) DEFAULT 0 NOT NULL,
    power_w numeric(10,2) DEFAULT 0 NOT NULL,
    energy_wh numeric(14,3) DEFAULT 0 NOT NULL,
    fault public.fault_code DEFAULT 'ok'::public.fault_code NOT NULL,
    CONSTRAINT telemetry_channels_channel_index_check CHECK (((channel_index >= 0) AND (channel_index <= 5)))
);


--
-- Name: telemetry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.telemetry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: telemetry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.telemetry_id_seq OWNED BY public.telemetry.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    password_hash text NOT NULL,
    name text NOT NULL,
    phone text,
    avatar_url text,
    title text DEFAULT 'Home owner'::text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: telemetry id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry ALTER COLUMN id SET DEFAULT nextval('public.telemetry_id_seq'::regclass);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: commands commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_pkey PRIMARY KEY (id);


--
-- Name: device_channels device_channels_device_id_channel_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_channels
    ADD CONSTRAINT device_channels_device_id_channel_id_key UNIQUE (device_id, channel_id);


--
-- Name: device_channels device_channels_device_id_channel_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_channels
    ADD CONSTRAINT device_channels_device_id_channel_index_key UNIQUE (device_id, channel_index);


--
-- Name: device_channels device_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_channels
    ADD CONSTRAINT device_channels_pkey PRIMARY KEY (id);


--
-- Name: device_settings device_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_settings
    ADD CONSTRAINT device_settings_pkey PRIMARY KEY (device_id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: devices devices_serial_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_serial_number_key UNIQUE (serial_number);


--
-- Name: device_claim_requests device_claim_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_claim_requests
    ADD CONSTRAINT device_claim_requests_pkey PRIMARY KEY (serial_number);


--
-- Name: energy_hourly energy_hourly_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_hourly
    ADD CONSTRAINT energy_hourly_pkey PRIMARY KEY (device_id, channel_index, bucket);


--
-- Name: home_members home_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.home_members
    ADD CONSTRAINT home_members_pkey PRIMARY KEY (home_id, user_id);


--
-- Name: homes homes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.homes
    ADD CONSTRAINT homes_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: rooms rooms_home_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_home_id_name_key UNIQUE (home_id, name);


--
-- Name: rooms rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: telemetry_channels telemetry_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_channels
    ADD CONSTRAINT telemetry_channels_pkey PRIMARY KEY (telemetry_id, channel_index);


--
-- Name: telemetry telemetry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry
    ADD CONSTRAINT telemetry_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: alerts_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alerts_device_idx ON public.alerts USING btree (device_id, raised_at DESC);


--
-- Name: alerts_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX alerts_open_idx ON public.alerts USING btree (device_id, COALESCE((channel_index)::integer, '-1'::integer), code) WHERE (cleared_at IS NULL);


--
-- Name: audit_log_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_user_idx ON public.audit_log USING btree (user_id, created_at DESC);


--
-- Name: commands_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_device_idx ON public.commands USING btree (device_id, created_at DESC);


--
-- Name: commands_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_pending_idx ON public.commands USING btree (device_id, created_at) WHERE (status = 'pending'::public.command_status);


--
-- Name: devices_home_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_home_idx ON public.devices USING btree (home_id);


--
-- Name: devices_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_room_idx ON public.devices USING btree (room_id);


--
-- Name: energy_hourly_bucket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX energy_hourly_bucket_idx ON public.energy_hourly USING btree (device_id, bucket DESC);


--
-- Name: home_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX home_members_user_idx ON public.home_members USING btree (user_id);


--
-- Name: homes_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX homes_owner_idx ON public.homes USING btree (owner_id);


--
-- Name: refresh_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_user_idx ON public.refresh_tokens USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: rooms_home_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rooms_home_idx ON public.rooms USING btree (home_id, sort_order);


--
-- Name: telemetry_channels_series_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telemetry_channels_series_idx ON public.telemetry_channels USING btree (device_id, channel_index, recorded_at DESC);


--
-- Name: telemetry_device_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telemetry_device_time_idx ON public.telemetry USING btree (device_id, recorded_at DESC);


--
-- Name: telemetry_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telemetry_time_idx ON public.telemetry USING btree (recorded_at DESC);


--
-- Name: alerts alerts_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: alerts alerts_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: commands commands_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: commands commands_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: device_channels device_channels_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_channels
    ADD CONSTRAINT device_channels_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_settings device_settings_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_settings
    ADD CONSTRAINT device_settings_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_settings device_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_settings
    ADD CONSTRAINT device_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: devices devices_home_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_home_id_fkey FOREIGN KEY (home_id) REFERENCES public.homes(id) ON DELETE CASCADE;


--
-- Name: devices devices_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE SET NULL;


--
-- Name: energy_hourly energy_hourly_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_hourly
    ADD CONSTRAINT energy_hourly_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: home_members home_members_home_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.home_members
    ADD CONSTRAINT home_members_home_id_fkey FOREIGN KEY (home_id) REFERENCES public.homes(id) ON DELETE CASCADE;


--
-- Name: home_members home_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.home_members
    ADD CONSTRAINT home_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: homes homes_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.homes
    ADD CONSTRAINT homes_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: rooms rooms_home_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_home_id_fkey FOREIGN KEY (home_id) REFERENCES public.homes(id) ON DELETE CASCADE;


--
-- Name: telemetry_channels telemetry_channels_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_channels
    ADD CONSTRAINT telemetry_channels_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: telemetry_channels telemetry_channels_telemetry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_channels
    ADD CONSTRAINT telemetry_channels_telemetry_id_fkey FOREIGN KEY (telemetry_id) REFERENCES public.telemetry(id) ON DELETE CASCADE;


--
-- Name: telemetry telemetry_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry
    ADD CONSTRAINT telemetry_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict xhesnPrJAqzvxbvXY4bHhnWDPVBWynhkcZsujzjAyWG3uFIZ9mQhp0ycYfiNTYi


--
-- Name: firmware_releases firmware_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firmware_releases
    ADD CONSTRAINT firmware_releases_pkey PRIMARY KEY (id);


--
-- Name: firmware_releases firmware_releases_model_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firmware_releases
    ADD CONSTRAINT firmware_releases_model_version_key UNIQUE (model, version);


--
-- Name: firmware_releases firmware_releases_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firmware_releases
    ADD CONSTRAINT firmware_releases_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: firmware_releases_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX firmware_releases_current_idx ON public.firmware_releases USING btree (model) WHERE is_current;


--
-- Name: firmware_releases_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX firmware_releases_model_idx ON public.firmware_releases USING btree (model, created_at DESC);


--
-- Name: api_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_requests ALTER COLUMN id SET DEFAULT nextval('public.api_requests_id_seq'::regclass);


--
-- Name: api_requests api_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_requests
    ADD CONSTRAINT api_requests_pkey PRIMARY KEY (id);


--
-- Name: api_requests_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_requests_created_idx ON public.api_requests USING btree (created_at DESC);


--
-- Name: api_requests_route_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_requests_route_idx ON public.api_requests USING btree (route, created_at DESC);


--
-- Name: api_requests_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_requests_device_idx ON public.api_requests USING btree (device_id, created_at DESC) WHERE (device_id IS NOT NULL);


--
-- Name: sensor_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_settings (
    device_id uuid NOT NULL,
    temp_high_c numeric(6,2),
    temp_low_c numeric(6,2),
    humidity_high_pct numeric(5,2),
    humidity_low_pct numeric(5,2),
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sensor_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensor_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    sensor text NOT NULL,
    kind text NOT NULL,
    message text NOT NULL,
    value numeric(6,2),
    threshold numeric(6,2),
    raised_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_at timestamp with time zone,
    CONSTRAINT sensor_alerts_kind_check CHECK ((kind = ANY (ARRAY['temp_high'::text, 'temp_low'::text, 'humidity_high'::text, 'humidity_low'::text]))),
    CONSTRAINT sensor_alerts_sensor_check CHECK ((sensor = ANY (ARRAY['t1'::text, 't2'::text, 't3'::text, 't4'::text, 'h1'::text, 'h2'::text])))
);


--
-- Name: sensor_settings sensor_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_settings
    ADD CONSTRAINT sensor_settings_pkey PRIMARY KEY (device_id);


--
-- Name: sensor_alerts sensor_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_alerts
    ADD CONSTRAINT sensor_alerts_pkey PRIMARY KEY (id);


--
-- Name: sensor_settings sensor_settings_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_settings
    ADD CONSTRAINT sensor_settings_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: sensor_alerts sensor_alerts_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensor_alerts
    ADD CONSTRAINT sensor_alerts_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: sensor_alerts_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sensor_alerts_device_idx ON public.sensor_alerts USING btree (device_id, raised_at DESC);


--
-- Name: sensor_alerts_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sensor_alerts_open_idx ON public.sensor_alerts USING btree (device_id, sensor, kind) WHERE (cleared_at IS NULL);
