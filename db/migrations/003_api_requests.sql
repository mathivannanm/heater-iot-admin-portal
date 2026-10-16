-- 003: API request log
--
-- One row per call to any /api route: what was asked, by which kind of
-- credential, what came back and how long it took. It exists to answer
-- "is the firmware / mobile app / device actually calling us?" without
-- grepping server output, and to spot a board that is failing auth or
-- posting malformed frames in a loop.
--
-- `device_id` is deliberately not a foreign key: the log must survive a device
-- being decommissioned, because "what was it doing before we removed it" is a
-- question people ask. Rows are pruned after HEATER_API_LOG_RETENTION_MS.
--
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.api_requests (
    id           bigserial   NOT NULL,
    method       text        NOT NULL,
    route        text        NOT NULL,
    path         text        NOT NULL,
    query        text,
    status       smallint    NOT NULL,
    duration_ms  integer     NOT NULL,
    credential   text        NOT NULL,
    device_id    uuid,
    ip           inet,
    user_agent   text,
    error        text,
    created_at   timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_requests_pkey PRIMARY KEY (id),
    CONSTRAINT api_requests_status_check CHECK (((status >= 100) AND (status <= 599)))
);

CREATE INDEX IF NOT EXISTS api_requests_created_idx
  ON public.api_requests USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS api_requests_route_idx
  ON public.api_requests USING btree (route, created_at DESC);

CREATE INDEX IF NOT EXISTS api_requests_device_idx
  ON public.api_requests USING btree (device_id, created_at DESC)
  WHERE (device_id IS NOT NULL);

COMMIT;
