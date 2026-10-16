-- 002: firmware releases
--
-- The admin portal's firmware update module. A release is an uploaded .bin
-- with a version string. It starts as a draft, becomes visible to devices when
-- published, and exactly one published release per model can be marked
-- "current" - the version the fleet is expected to run and the one a device
-- is handed when it asks for an update.
--
-- The image itself lives in the row (bytea). An ESP32 image is a few hundred
-- kilobytes to a few megabytes, which is well within what Postgres handles
-- comfortably, and keeping it next to its metadata means the database backup
-- is the complete record: no separate object store to keep in step.
--
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.firmware_releases (
    id            uuid        DEFAULT gen_random_uuid() NOT NULL,
    model         text        DEFAULT 'HEATER Ver1'::text NOT NULL,
    version       text        NOT NULL,
    filename      text        NOT NULL,
    size_bytes    integer     NOT NULL,
    sha256        text        NOT NULL,
    notes         text,
    image         bytea       NOT NULL,
    is_current    boolean     DEFAULT false NOT NULL,
    published_at  timestamp with time zone,
    uploaded_by   uuid,
    created_at    timestamp with time zone DEFAULT now() NOT NULL,
    updated_at    timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT firmware_releases_pkey PRIMARY KEY (id),
    CONSTRAINT firmware_releases_model_version_key UNIQUE (model, version),
    CONSTRAINT firmware_releases_size_check CHECK ((size_bytes > 0)),
    CONSTRAINT firmware_releases_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    -- A draft can never be current: devices only ever see published images.
    CONSTRAINT firmware_releases_current_published_check CHECK (((NOT is_current) OR (published_at IS NOT NULL)))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'firmware_releases_uploaded_by_fkey') THEN
    ALTER TABLE public.firmware_releases
      ADD CONSTRAINT firmware_releases_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- One current release per model.
CREATE UNIQUE INDEX IF NOT EXISTS firmware_releases_current_idx
  ON public.firmware_releases USING btree (model) WHERE is_current;

CREATE INDEX IF NOT EXISTS firmware_releases_model_idx
  ON public.firmware_releases USING btree (model, created_at DESC);

COMMIT;
