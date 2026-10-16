# HEATER Ver1 admin portal — HTTP API

Every route lives under `/api` and speaks JSON. This document lists each
endpoint, the headers it needs, every parameter it reads, and what it returns.
It was written from the route handlers in `app/api/**` and checked against a
running server on 2026-09-09.

- [Conventions](#conventions)
- [Authentication and headers](#authentication-and-headers)
- [Endpoint index](#endpoint-index)
- [Device-facing endpoints](#device-facing-endpoints) — registration, live data
  ingest, heartbeat, command claim and acknowledgement
- [Admin endpoints](#admin-endpoints) — fleet, device detail, settings,
  commands, alerts, history, energy, rooms, stats, live stream
- [Firmware endpoints](#firmware-endpoints) — upload, publish, current version,
  roll-out, device update check and download
- [Request log](#request-log) — is the API being called, by whom, with what result
- [Public endpoints](#public-endpoints) — health
- [Shared types](#shared-types) — enums, time ranges, response objects
- [Environment variables](#environment-variables)

---

## Conventions

**Base URL.** `http://<host>:<port>/api`. In development this is
`http://localhost:3000/api`.

**Content type.** Requests with a body must send
`Content-Type: application/json` and a JSON **object** at the top level.
An array, a bare value or invalid JSON is rejected with `400`.

**Success.** `200 OK` unless stated (`201` on first registration, `202` when a
command is queued). Body is a JSON object. Every response carries
`Cache-Control: no-store`.

**Errors.** Always `{ "error": "<message>" }`, optionally with `"detail"`.

| Status | Meaning |
| --- | --- |
| `400` | Body is not a JSON object, or not valid JSON |
| `401` | Credentials missing or wrong (admin, provisioning, or device) |
| `403` | Device credentials do not match this device id, or a command belongs to another device |
| `404` | Device, command or alert not found |
| `409` | Registration failed because no `homes` row exists to attach the device to |
| `422` | A field failed validation. The message names the field and the rule, e.g. `"level" must be one of: off, low, medium, high` |
| `503` | Health check: database unreachable or schema incomplete |

**Field semantics.** For optional fields, *absent* means "leave the stored
value alone" and an explicit `null` means "clear it / no reading". Anything
malformed is rejected with `422`, never silently coerced.

**CORS.** Every `/api` route answers cross-origin browser requests. All
origins are allowed by default (`Access-Control-Allow-Origin: *`); preflight
`OPTIONS` requests are answered automatically. The custom auth headers
(`X-Admin-Key`, `X-Device-Key`, `X-App-Key`, `X-Provisioning-Key`), `Range`
and `If-None-Match` are permitted, and the firmware download headers
(`X-Firmware-*`, `ETag`, `Content-Range`, `Content-Length`) are exposed to
scripts. Restrict origins with `HEATER_CORS_ORIGINS` (see
[Environment variables](#environment-variables)); with a restricted list the
matching origin is echoed and cookies are allowed.

**Timestamps.** All times are Unix epoch **milliseconds** (`number`).

**Device ids.** UUIDs, minted by the server at registration.

---

## Authentication and headers

There are three credentials. Each endpoint below says which one it needs.

| Role | Header (either form works) | Secret comes from | When unset |
| --- | --- | --- | --- |
| **Admin** | `X-Admin-Key: <key>` or `Authorization: Bearer <key>` or cookie `heater_admin=<key>` | `HEATER_ADMIN_KEY` | API is **open** (dev only; the dashboard shows a warning banner) |
| **Provisioning** | `X-Provisioning-Key: <key>` or `Authorization: Bearer <key>` | `HEATER_PROVISIONING_KEY` | Registration is **open** (dev only) |
| **Device** | `X-Device-Key: <key>` or `Authorization: Bearer <key>` | The `deviceKey` returned once by `POST /api/devices` | Never open. Missing key → `401`, wrong key or unknown device → `403` |
| **App** (mobile) | `X-App-Key: <key>` or `Authorization: Bearer <key>`; an admin key is also accepted | `HEATER_APP_KEY` | Firmware check/download are **open** (dev only) |

Notes:

- `HEATER_ADMIN_KEY` is set in this project's `.env.local`, so every admin
  endpoint currently requires the header. `GET /api/health` reports
  `adminAuthConfigured: true` when the key is active.
- **The dashboard itself signs in with `POST /api/auth/login`** (see below),
  which sets the `heater_admin` cookie every admin route already accepts.
  There is no other way for a browser to be authenticated - a raw `fetch()`
  from the dashboard with no cookie gets the same `401` a script would.
- Only the SHA-256 of a device key is stored. Re-registering a serial number
  mints a **new** key; always store the one you get back.
- Comparisons are constant-time. A missing device and a wrong key return the
  same `403`, so ids cannot be enumerated.
- Common request headers:

  ```http
  Content-Type: application/json      # any request with a body
  X-Admin-Key: <HEATER_ADMIN_KEY>     # admin routes
  X-Device-Key: <deviceKey>           # device routes
  X-Provisioning-Key: <key>           # POST /api/devices, only if HEATER_PROVISIONING_KEY is set
  X-App-Key: <HEATER_APP_KEY>         # mobile app: /api/firmware/current[/download]
  X-Forwarded-For / X-Real-IP         # optional; recorded as the client IP in the audit log
  ```

---

## Endpoint index

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/devices` | Provisioning | Register (or re-register) a device, get its key |
| `POST` | `/api/devices/{id}/telemetry` | Device (or Admin, sensor boards only) | **Post all live data** for one device |
| `POST` | `/api/devices/{id}/heartbeat` | Device | Proof of life without a frame |
| `GET` | `/api/devices/{id}/commands` | Device *or* Admin | Device: claim pending commands. Admin: read history |
| `PATCH` | `/api/devices/{id}/commands` | Device | Acknowledge or fail a command |
| `GET` | `/api/devices` | Admin | Fleet list with search, filter, sort, paging |
| `GET` | `/api/devices/{id}` | Admin | Full device view plus recent alerts, commands, audit |
| `PATCH` | `/api/devices/{id}` | Admin | Rename, move room, set firmware version |
| `DELETE` | `/api/devices/{id}` | Admin | Decommission (cascades) |
| `GET` | `/api/devices/{id}/settings` | Admin | Protection limits and climate config |
| `PATCH` | `/api/devices/{id}/settings` | Admin | Change them |
| `POST` | `/api/devices/{id}/commands` | Admin | Queue a command for the device |
| `GET` | `/api/devices/{id}/alerts` | Admin | Alerts for one device |
| `PATCH` | `/api/devices/{id}/alerts` | Admin | Acknowledge an alert |
| `GET` | `/api/devices/{id}/history` | Admin | Telemetry, channel, energy series and alerts for a window |
| `GET` | `/api/devices/{id}/energy` | Admin | Hourly energy rollup for a window |
| `GET` | `/api/sensors` | Admin | Temperature / humidity sensor boards with latest reading and online status |
| `GET` | `/api/sensors/{id}/latest` | Admin | Newest reading, settings and alerts for one sensor board |
| `GET` | `/api/sensors/{id}/history` | Admin | Time series of all eight values plus min / max / average |
| `GET` | `/api/sensors/{id}/export.csv` | Admin | Every stored frame in a window, as a CSV download |
| `GET` | `/api/sensors/{id}/settings` | Admin | Alert thresholds and sensor labels |
| `PATCH` | `/api/sensors/{id}/settings` | Admin | Change them |
| `GET` | `/api/sensors/{id}/alerts` | Admin | Threshold alerts for one sensor board |
| `GET` | `/api/alerts` | Admin | Fleet-wide alert log |
| `GET` | `/api/rooms` | Admin | Rooms with device counts |
| `GET` | `/api/stats` | Admin | Fleet counters and thresholds |
| `GET` | `/api/events` | Admin | Server-Sent Events live stream |
| `GET` | `/api/firmware` | Admin | List firmware releases |
| `POST` | `/api/firmware` | Admin | Upload a .bin (multipart), optionally publish / make current |
| `GET` | `/api/firmware/{id}` | Admin | One release's metadata |
| `PATCH` | `/api/firmware/{id}` | Admin | Publish, make current, withdraw, edit notes |
| `DELETE` | `/api/firmware/{id}` | Admin | Delete a non-current release |
| `GET` | `/api/firmware/{id}/download` | Admin | Download the image |
| `POST` | `/api/firmware/{id}/rollout` | Admin | Queue `FIRMWARE_UPDATE` for outdated devices |
| `GET` | `/api/firmware/current` | App | **Mobile:** current version for a model, update check, published list |
| `GET` / `HEAD` | `/api/firmware/current/download` | App | **Mobile:** download the current (or a named published) image |
| `GET` | `/api/devices/{id}/firmware` | Device *or* Admin | "Is there an update for me?" |
| `GET` | `/api/devices/{id}/firmware/download` | Device *or* Admin | Download the current (or a named published) image |
| `GET` | `/api/logs` | Admin | API request log: per-route summary or individual calls |
| `GET` | `/api/health` | None | Liveness for deployment checks |

There is no fleet-wide bulk ingest. Live data is posted **per device**, one
frame per call, to `/api/devices/{id}/telemetry`.

---

## Device-facing endpoints

### `POST /api/devices` — register a device

Firmware self-registration. Matched on `serialNumber`: an existing serial
updates its row (firmware, network details, new key) and keeps its history.

**Headers**

| Header | Required | Value |
| --- | --- | --- |
| `Content-Type` | yes | `application/json` |
| `X-Provisioning-Key` or `Authorization: Bearer` | only if `HEATER_PROVISIONING_KEY` is set | provisioning secret |

**Body**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `name` | string | **yes** | 1–80 chars, trimmed |
| `serialNumber` | string | **yes** | 1–64 chars, trimmed, unique per device |
| `firmwareVersion` | string \| null | no | ≤ 32 chars |
| `model` | string | no | ≤ 64 chars, default `"HEATER Ver1"` |
| `bluetoothName` | string | no | ≤ 64 chars, default `"HEATER_VER1"` |
| `bluetoothAddress` | string \| null | no | ≤ 64 chars |
| `homeSsid` | string \| null | no | ≤ 64 chars |
| `localAddress` | string \| null | no | ≤ 128 chars, e.g. `http://192.168.1.50` |
| `roomId` | string \| null | no | ≤ 64 chars, UUID of an existing room |
| `deviceKey` | string | no | ≤ 128 chars. Supply your own key; otherwise the server mints a 48-hex-char one |

If no channels exist for the device, the standard six are created:
`h1`–`h4` (heaters), `fan`, `light`, channel indices 0–5. A device registered
with model `"TEMP-HUM Ver1"` is a sensor board: it gets no channels and is
listed under `/api/sensors` instead of `/api/devices`.

**Response** — `201 Created` on first registration, `200 OK` on re-registration

On re-registration `name` replaces the stored name only while the device's
`nameSource` is `"device"`; once it has been renamed on the portal
(`PATCH /api/devices/:id`) the portal's name is kept.

```json
{
  "device": { "...DeviceView (see Shared types)..." },
  "deviceKey": "3f9a…(48 hex chars)",
  "created": true
}
```

`deviceKey` is returned **only here**. Store `device.id` and `deviceKey`.

**Errors** — `401` bad provisioning key · `409` no home exists in the
database · `422` validation.

**Example**

```bash
curl -X POST http://localhost:3000/api/devices \
  -H "Content-Type: application/json" \
  -H "X-Provisioning-Key: $HEATER_PROVISIONING_KEY" \
  -d '{"name":"Living Room Heater","serialNumber":"HTR-VER1-000001","firmwareVersion":"1.0.0"}'
```

---

### `POST /api/devices/{id}/telemetry` — post all live data

**The ingest endpoint.** One frame per cycle (default every 15 s). Every field
is optional so a constrained board can send a partial frame. The frame is
written to `telemetry`, per-channel readings to `channel_readings`, energy is
rolled into `energy_hourly`, the alert rules run, and the change is pushed to
the dashboard over `/api/events`. The response carries any queued commands, so
one round trip per cycle is enough.

**Path**

| Param | Type | Description |
| --- | --- | --- |
| `id` | UUID | Device id from registration |

**Headers**

| Header | Required | Value |
| --- | --- | --- |
| `Content-Type` | yes | `application/json` |
| `X-Device-Key` or `Authorization: Bearer` | **yes** | the device's key |

**Body — identity**

| Field | Type | Rules |
| --- | --- | --- |
| `deviceName` | string | ≤ 80 chars. The board's own name; becomes the device name while `nameSource` is `"device"`, ignored once renamed on the portal |

**Body — heat control**

| Field | Type | Rules |
| --- | --- | --- |
| `level` | enum | `"off"` \| `"low"` \| `"medium"` \| `"high"` |
| `levelValue` | number | 0–3 |
| `mode` | string | ≤ 32 chars, free text (e.g. `"heat"`); omitted → `level` in capitals (`"HIGH"`), as the firmware reports it |
| `manual` | boolean | manual override active |
| `autoFan` | boolean | auto-fan active |
| `tripped` | boolean | protection has tripped |

**Body — climate**

| Field | Type | Rules |
| --- | --- | --- |
| `climate` | boolean | climate (thermostat) mode on |
| `climateTargetC` | number \| null | 10–60 (the firmware's `settemp` range) |

**Body — electrical**

| Field | Type | Rules |
| --- | --- | --- |
| `totalCurrentA` | number | 0–200 |
| `sumCurrentA` | number | 0–200 (sum of channel CTs) |
| `totalPowerW` | number | 0–100000 |
| `readingSource` | string | ≤ 32 chars (e.g. `"ct"`, `"meter"`) |
| `meterVoltageV` | number | 0–500 |
| `mainsVoltageV` | number | 0–500 |

**Body — temperature and humidity** (bounds are sensor physical range, not room range)

A number outside these bounds is treated as a failed sensor: it is stored as `null`, the rest of the frame is accepted, and the field name is listed in the response's `ignoredFields`. A value that is not a number or `null` is still rejected with `422`.

| Field | Type | Rules |
| --- | --- | --- |
| `temp1C`, `temp2C`, `temp3C`, `temp4C` | number \| null | −55–300 |
| `dhtTempC` | number \| null | −55–300 |
| `avgTempC` | number \| null | −55–300; the board's own average, stored as sent |
| `maxTempC` | number \| null | −55–300 |
| `humidity1Pct`, `humidity2Pct`, `humidity3Pct` | number \| null | 0–100 |

**Body — protection limits in force on the device**

| Field | Type | Rules |
| --- | --- | --- |
| `currentLimitA` | number \| null | 0–200 |
| `totalLimitA` | number \| null | 0–200 |
| `temperatureLimitC` | number \| null | 0–300 |

**Body — connectivity**

| Field | Type | Rules |
| --- | --- | --- |
| `wifi` | enum | `"AP"` (device is its own access point) \| `"STA"` (joined home Wi-Fi) |
| `ip` | string \| null | ≤ 45 chars |
| `bluetoothClient` | boolean | a BLE client is attached |
| `apiKeySet` | boolean | firmware has an API key stored |
| `uptimeSeconds` | number | ≥ 0 |
| `rssiDbm` | number \| null | −120–0. Wi-Fi signal strength |
| `wifiRssiDbm` | number \| null | −120–0. Alias for `rssiDbm`, as sent by the firmware reference sketch; ignored if `rssiDbm` is present |
| `bleRssiDbm` | number \| null | −120–0. RSSI of the connected Bluetooth peer; omit when none is connected |
| `rssi` | number \| null | −120–0. Firmware short alias for `rssiDbm`; ignored if `rssiDbm` or `wifiRssiDbm` is present |

**Body — per-channel readings**

| Field | Type | Rules |
| --- | --- | --- |
| `channels` | array of objects \| null | ≤ 6 entries. Absent, `null` or `[]` all mean "no channel data in this frame" — nothing is zeroed |

Each channel object:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `channelIndex` | integer | **yes** | 0–5, unique within the array |
| `channelId` | string | no | ≤ 32 chars (`"h1"`…`"h4"`, `"fan"`, `"light"`) |
| `isOn` | boolean | no | relay state |
| `currentA` | number | no | 0–200 |
| `powerW` | number | no | 0–50000 |
| `energyWh` | number | no | ≥ 0, cumulative |
| `fault` | enum | no | `"ok"` \| `"over_current"` \| `"no_load"` \| `"over_temperature"` |

Any extra keys are ignored by validation but the **entire raw body is stored**
in `telemetry.raw` for forensics.

**Response** — `200 OK`

```json
{
  "accepted": true,
  "receivedAt": 1788946390193,
  "nextIntervalMs": 15000,
  "ignoredFields": [],
  "commands": [ { "...DeviceCommand, status \"delivered\"..." } ]
}
```

`ignoredFields` lists temperature/humidity fields that were out of range and
stored as `null` (for example `["dhtTempC"]` when the DHT read fails). Empty
when every reading was accepted.

`commands` holds every command that was pending; they are marked `delivered`
by this call. Reply with `PATCH /api/devices/{id}/commands` once executed.

**Errors** — `400` bad JSON · `401` no key · `403` wrong key / unknown id ·
`404` device deleted since auth · `422` validation (message names the field).

**Example — full frame**

```bash
curl -X POST http://localhost:3000/api/devices/$DEVICE_ID/telemetry \
  -H "Content-Type: application/json" \
  -H "X-Device-Key: $DEVICE_KEY" \
  -d '{
    "level": "high", "levelValue": 3, "mode": "heat", "manual": true, "autoFan": false, "tripped": false,
    "climate": true, "climateTargetC": 22,
    "totalCurrentA": 8.1, "sumCurrentA": 8.0, "totalPowerW": 1850, "readingSource": "ct",
    "meterVoltageV": 229, "mainsVoltageV": 230,
    "temp1C": 41.2, "temp2C": 39.8, "temp3C": null, "dhtTempC": 24.5, "maxTempC": 41.2, "humidity1Pct": 55,
    "currentLimitA": 12, "totalLimitA": 30, "temperatureLimitC": 85,
    "wifi": "STA", "ip": "192.168.1.50", "bluetoothClient": false, "apiKeySet": true,
    "uptimeSeconds": 3600, "rssi": -61,
    "channels": [
      { "channelIndex": 0, "channelId": "h1",  "isOn": true, "currentA": 7.8, "powerW": 1800, "energyWh": 12.5, "fault": "ok" },
      { "channelIndex": 4, "channelId": "fan", "isOn": true, "currentA": 0.3, "powerW": 50 }
    ]
  }'
```

**Example — minimal frame**

```bash
curl -X POST http://localhost:3000/api/devices/$DEVICE_ID/telemetry \
  -H "Content-Type: application/json" -H "X-Device-Key: $DEVICE_KEY" \
  -d '{"level":"off","totalPowerW":0,"temp1C":23.1}'
```

**Example — validation error**

```
POST {"level":"max"}            → 422 {"error":"\"level\" must be one of: off, low, medium, high"}
POST {"channels":[{"channelIndex":9}]} → 422 {"error":"\"channelIndex\" must be between 0 and 5"}
POST {"dhtTempC":"hot"}         → 422 {"error":"\"dhtTempC\" must be a finite number or null"}
```

**Example — failed sensor (accepted)**

```
POST {"temp1C":41.2,"dhtTempC":2147483647} → 200 {"accepted":true,…,"ignoredFields":["dhtTempC"],…}
```

---

### `POST /api/devices/{id}/heartbeat` — proof of life

For an idle board with nothing to report. Advances `last_seen_at` so the
sweeper does not mark it offline, writes **no** telemetry row, and returns
pending commands.

**Headers** — `X-Device-Key` or `Authorization: Bearer` (required). No body.

**Response** — `200 OK`

```json
{ "accepted": true, "receivedAt": 1788946390343, "nextIntervalMs": 15000, "commands": [] }
```

**Errors** — `401` / `403` credentials · `404` device not found.

```bash
curl -X POST http://localhost:3000/api/devices/$DEVICE_ID/heartbeat -H "X-Device-Key: $DEVICE_KEY"
```

---

### `GET /api/devices/{id}/commands` — claim pending commands (device)

When called with a **device** key, returns and claims every `pending` command
(marks them `delivered`). When called with an **admin** key, returns history
without claiming — see the admin section.

**Headers** — `X-Device-Key` or `Authorization: Bearer`.

**Response** — `200 OK` `{ "commands": [ DeviceCommand, … ] }`

---

### `PATCH /api/devices/{id}/commands` — acknowledge or fail a command

**Headers** — `Content-Type: application/json`, `X-Device-Key` or
`Authorization: Bearer`.

**Body**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `commandId` | string | **yes** | ≤ 64 chars, UUID from the delivered command |
| `status` | enum | no | `"acked"` (default) \| `"failed"` |
| `reply` | string \| null | no | ≤ 500 chars, device's reply text |
| `error` | string \| null | no | ≤ 500 chars, why it failed |

**Response** — `200 OK` `{ "command": DeviceCommand }`

**Errors** — `404` command not found · `403` command belongs to another device
· `422` validation.

```bash
curl -X PATCH http://localhost:3000/api/devices/$DEVICE_ID/commands \
  -H "Content-Type: application/json" -H "X-Device-Key: $DEVICE_KEY" \
  -d '{"commandId":"d34f8463-30ef-43ac-94c0-f71055189b6f","status":"acked","reply":"ok"}'
```

---

## Admin endpoints

All routes in this section require the **admin** credential:
`X-Admin-Key: <HEATER_ADMIN_KEY>` (or `Authorization: Bearer`, or the
`heater_admin` cookie the dashboard sets). Missing or wrong → `401
{"error":"Admin authentication required"}`.

### `GET /api/devices` — fleet list

**Query parameters**

| Param | Type | Default | Values |
| --- | --- | --- | --- |
| `search` | string | — | Case-insensitive substring of name, serial, model, room, home, Bluetooth name, firmware, IP, local address, SSID or channel names |
| `status` | enum | `all` | `all` \| `online` \| `offline` \| `heating` \| `fault` \| `tripped` |
| `connection` | enum | `all` | `all` \| `sta` \| `ap` \| `bluetooth` |
| `kind` | enum | `all` | `all` \| `heater` \| `fan` \| `light` |
| `room` | string | — | room id |
| `sortBy` | enum | `name` | `name` \| `status` \| `lastSeen` \| `temperature` \| `power` \| `room` \| `alerts` |
| `sortDir` | enum | `asc` | `asc` \| `desc` |
| `page` | integer | `1` | 1-based |
| `pageSize` | integer | `20` | |

**Response**

```json
{ "devices": [ DeviceView, … ], "total": 12, "page": 1, "pageSize": 20, "pageCount": 1 }
```

```bash
curl -H "X-Admin-Key: $HEATER_ADMIN_KEY" "http://localhost:3000/api/devices?status=online&sortBy=power&sortDir=desc"
```

---

### `GET /api/devices/{id}` — device detail

**Response**

```json
{
  "device": DeviceView,
  "alerts":   [ DeviceAlert, … ],     // latest 50
  "commands": [ DeviceCommand, … ],   // latest 25
  "audit":    [ AuditEntry, … ]       // latest 25
}
```

The most recent frame is at `device.telemetry`; per-channel readings at
`device.channels[n].reading`; signal at `device.signal`.

---

### `PATCH /api/devices/{id}` — rename / move / set firmware

**Body** (send only what changes)

| Field | Type | Rules |
| --- | --- | --- |
| `name` | string | 1–80 chars, non-empty. Also sets `nameSource` to `"portal"` unless one is given |
| `nameSource` | enum | `"portal"` keeps the current name; `"device"` follows the board's name again from its next frame or registration |
| `roomId` | string \| null | ≤ 64 chars, `null` to unassign |
| `firmwareVersion` | string \| null | ≤ 32 chars |

**Response** `{ "device": DeviceView }` · **Errors** `404`, `422`.

---

### `DELETE /api/devices/{id}` — decommission

Cascades to telemetry, readings, alerts, commands. Audited first.

**Response** `{ "removed": true, "id": "<uuid>" }` · **Errors** `404`.

---

### `GET /api/devices/{id}/settings` — read protection limits

**Response** `{ "settings": DeviceSettings }`

### `PATCH /api/devices/{id}/settings` — change protection limits

These are the limits the ingest layer checks each frame against. Changing them
does **not** reprogram the hardware; send a command for that.

**Body** (at least one field required)

| Field | Type | Rules |
| --- | --- | --- |
| `currentLimitA` | number | 0–200 |
| `totalLimitA` | number | 0–200 |
| `temperatureLimitC` | number | 0–300 |
| `mainsVoltageV` | number | 0–500 |
| `climateTargetC` | number | 10–35 |
| `autoFan` | boolean | |
| `climateEnabled` | boolean | |
| `userId` | string | ≤ 64 chars, UUID recorded as `updated_by` |

**Response** `{ "settings": DeviceSettings }`

**Errors** `404` · `422 "No recognised settings were supplied"` · `422` bounds.

```bash
curl -X PATCH http://localhost:3000/api/devices/$DEVICE_ID/settings \
  -H "Content-Type: application/json" -H "X-Admin-Key: $HEATER_ADMIN_KEY" \
  -d '{"currentLimitA":10,"climateTargetC":23}'
```

---

### `GET /api/devices/{id}/commands` — command history (admin)

**Query** `limit` (integer, default 50).

**Response** `{ "commands": [ DeviceCommand, … ] }` — read-only, nothing is claimed.

### `POST /api/devices/{id}/commands` — queue a command

Commands are queued, not pushed. The device collects them on its next
telemetry or heartbeat round trip. Unclaimed commands expire after 2 minutes.

**Body**

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `command` | string | **yes** | 1–200 chars, free text understood by the firmware |
| `issuedBy` | string \| null | no | ≤ 64 chars, user UUID |

**Response** — `202 Accepted`

```json
{ "command": DeviceCommand, "queued": true, "deviceOnline": true }
```

```bash
curl -X POST http://localhost:3000/api/devices/$DEVICE_ID/commands \
  -H "Content-Type: application/json" -H "X-Admin-Key: $HEATER_ADMIN_KEY" \
  -d '{"command":"SET_LEVEL medium"}'
```

---

### `GET /api/devices/{id}/alerts` — alerts for one device

**Query**

| Param | Type | Default | Values |
| --- | --- | --- | --- |
| `open` | boolean | — | `true` open only, `false` resolved only, absent = both |
| `severity` | enum | — | `info` \| `warning` \| `critical` |
| `limit` | integer | `100` | |

**Response** `{ "alerts": [ DeviceAlert, … ] }`

### `PATCH /api/devices/{id}/alerts` — acknowledge an alert

Records that a human saw it. Does **not** clear it; an alert clears when the
condition stops being true in an ingested frame.

**Body**

| Field | Type | Required |
| --- | --- | --- |
| `alertId` | string (≤ 64) | **yes** |
| `userId` | string (≤ 64) | no |

**Response** `{ "acknowledged": true, "alertId": "…" }` · **Errors** `404
"Alert not found, or already acknowledged"`, `422`.

---

### `GET /api/devices/{id}/history` — everything for one time window

**Query** — see [Time ranges](#time-ranges): `range`, `from`, `to`.

**Response**

```json
{
  "range": "24h", "from": 1788859991899, "to": 1788946391899,
  "generatedAt": 1788946391950,            // when the server built the payload; `to` may be later (today runs to midnight)
  "telemetry": [ TelemetryPoint, … ],      // ≤ HEATER_HISTORY_MAX_SAMPLES (2000), evenly thinned
  "channels":  [ ChannelSeriesPoint, … ],
  "energy":    [ EnergyBucket, … ],        // hourly, see /energy for the shape
  "alerts":    [ DeviceAlert, … ],         // ≤ 200 raised inside the window
  "outages":   [ { "lastSeenAt": 1788900000000, "backAt": null, "from": 1788900000000, "to": null }, … ]
}
```

`outages` lists every gap in the board's frames longer than
`HEATER_OFFLINE_TIMEOUT_MS`, derived from the telemetry rows themselves.
`lastSeenAt` is the last frame before the gap (the moment the board went
offline; null when it predates the window), `backAt` the first frame after it
(null while the outage is still running). `from` / `to` are the same instants
clamped to the window; `to: null` means still offline now.

### `GET /api/devices/{id}/energy` — hourly energy rollup

**Query** — `range`, `from`, `to`.

**Response**

```json
{
  "range": "today", "from": 1788912000000, "to": 1788946306469,
  "buckets": [ { "deviceId": "…", "channelIndex": 0, "channelId": "h1", "bucket": 1788944400000, "energyWh": 12.5, "avgPowerW": 1650, "peakPowerW": 1800, "onSamples": 4, "samples": 4 }, … ],
  "totals":  [ { "channelIndex": 0, "channelId": "h1", "name": "Heater 1", "energyWh": 12.5, "peakPowerW": 1800, "onSamples": 4 }, … ]
}
```

---

### `GET /api/alerts` — fleet-wide alert log

**Query**

| Param | Type | Default | Values |
| --- | --- | --- | --- |
| `open` | boolean | — | `true` / `false` / absent = both |
| `severity` | enum | — | `info` \| `warning` \| `critical` |
| `deviceId` | UUID | — | |
| `range`, `from`, `to` | | — | Only applied when `range` or `from` is present; otherwise unbounded |
| `limit` | integer | `200` | |

**Response** `{ "alerts": [ DeviceAlert, … ] }`

### `GET /api/rooms`

**Response** `{ "rooms": [ { "id", "name", "icon", "deviceCount" }, … ] }` ordered by `sort_order`

### `GET /api/stats` — fleet counters

**Response**

```json
{
  "stats": FleetStats,
  "thresholds": { "offlineTimeoutMs": 45000, "staleDataMs": 20000, "telemetryIntervalMs": 15000 },
  "security": { "adminAuthConfigured": true }
}
```

### `GET /api/events` — live stream (Server-Sent Events)

`Content-Type: text/event-stream`. Send the admin header (or cookie). The
first message is a full snapshot; afterwards each message carries only what
changed. A `: keep-alive` comment is sent every 20 s.

Each `data:` line is one JSON `StreamMessage`:

| `kind` | Payload |
| --- | --- |
| `snapshot` | `{ devices: DeviceView[], stats: FleetStats, t }` |
| `device` | `{ reason, device: DeviceView, t }` — `reason` is one of `telemetry`, `registered`, `updated`, `went_offline`, `came_online`, `command`, `settings` |
| `device_removed` | `{ deviceId, t }` |
| `alert` | `{ alert: DeviceAlert, t }` |
| `stats` | `{ stats: FleetStats, t }` |

```bash
curl -N -H "X-Admin-Key: $HEATER_ADMIN_KEY" http://localhost:3000/api/events
```

---

## Temperature / humidity sensor endpoints

The **TEMP-HUM Ver1** board (four temperature probes, two humidity sensors, no
relays) uses the same two device-facing endpoints as a heater: it registers
with `POST /api/devices` and posts frames to `POST /api/devices/{id}/telemetry`.
The endpoints below are the read side, behind the portal's
**Temperature & Humidity** page. All of them need the **Admin** credential.

**What makes a device a sensor.** Its `model` is `"TEMP-HUM Ver1"`, *or* it has
ever posted a frame with `"deviceType": "temphum"`. A sensor is left out of
`GET /api/devices`, `GET /api/stats` and `GET /api/events`, which describe the
heater fleet; it gets no relay channels at registration. `GET /api/devices/{id}`
and `DELETE /api/devices/{id}` work for either kind.

**Online.** A sensor is online while its last frame is at most
`HEATER_SENSOR_OFFLINE_TIMEOUT_MS` (60 s) old.

**Null.** A sensor that is missing or not reading is `null` everywhere - in
the latest reading, in the series, as an empty cell in the CSV - and is left
out of the statistics. It is never reported as `0`.

**Telemetry fields the sensor board adds**

| Field | Type | Rules |
| --- | --- | --- |
| `dht2TempC` | number \| null | −55–300. Temperature measured by the second humidity sensor |
| `sensorsOk` | number \| null | 0–32. How many of the board's sensors are reading |
| `deviceType` | string \| null | ≤ 32 chars. `"temphum"` marks the device as a sensor board |

`temp1C`–`temp4C`, `humidity1Pct`, `humidity2Pct`, `dhtTempC` and `maxTempC`
are the fields documented under telemetry above. `channels` may be an empty
array.

**Admin credential on the telemetry endpoint.** For a sensor board only,
`POST /api/devices/{id}/telemetry` also accepts the admin credential when the
request carries **no** `X-Device-Key`. This is what lets the page's
Test / Simulator section post frames from a browser, which never holds a device
key. A request that does carry `X-Device-Key` is judged on that key alone, and
a heater accepts nothing but its device key.

### `GET /api/sensors` — sensor list

```json
{
  "sensors": [ { "...SensorDevice..." } ],
  "serverTime": 1790677547959,
  "offlineTimeoutMs": 60000
}
```

`SensorDevice`:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `name`, `model`, `serialNumber`, `firmwareVersion`, `homeSsid`, `localAddress`, `createdAt` | | identity |
| `paired` | boolean | the board holds a device key |
| `status` / `online` | `"online"` \| `"offline"` / boolean | derived from `lastSeenAt` on read |
| `lastSeenAt`, `dataAgeMs` | number \| null | null if the board has never reported |
| `signal` | `SignalInfo` | `bars` 0–4 from the measured RSSI, as for a heater |
| `latest` | `SensorReading` \| null | newest frame |
| `settings` | `SensorSettings` | thresholds and labels |
| `openAlertCount` | number | alerts not yet cleared |

`SensorReading`: `telemetryId`, `recordedAt`, `temp1C`–`temp4C`,
`humidity1Pct`, `humidity2Pct`, `dhtTempC`, `dht2TempC`, `maxTempC`,
`sensorsOk`, `sensorsTotal` (6), `wifi`, `ip`, `rssiDbm`, `uptimeSeconds`.
`sensorsOk` and `maxTempC` are what the board reported; when it reported
neither they are derived from the readings.

### `GET /api/sensors/{id}/latest` — latest reading

```json
{
  "sensor": { "...SensorDevice..." },
  "latest": { "...SensorReading, the same object as sensor.latest..." },
  "alerts": [ { "...SensorAlert, open first then newest, up to 50..." } ],
  "serverTime": 1790677547959,
  "offlineTimeoutMs": 60000
}
```

**Errors** — `404` unknown id, or the device is a heater.

### `GET /api/sensors/{id}/history` — time series

| Query | Values | Default |
| --- | --- | --- |
| `range` | `1h` \| `6h` \| `24h` \| `7d` | `24h` |

```json
{
  "range": "24h",
  "from": 1790591150000,
  "to": 1790677550000,
  "totalRows": 5023,
  "points": [
    { "t": 1790677547558, "temp1C": 24.6, "temp2C": 25.3, "temp3C": 23.7, "temp4C": null,
      "humidity1Pct": 58.5, "humidity2Pct": null, "dhtTempC": 24.6, "dht2TempC": null }
  ],
  "stats": {
    "temp1C": { "min": 21.0, "max": 31.5, "avg": 23.9, "count": 5023 },
    "temp4C": { "min": 24.0, "max": 32.4, "avg": 29.0, "count": 4539 }
  }
}
```

`points` is thinned to at most `HEATER_HISTORY_MAX_SAMPLES` real readings
(nothing is averaged). `stats` has one entry per value and is computed over
all `totalRows` frames; `count` is how many of them had a reading for that
sensor.

**Errors** — `404` unknown sensor · `422` unknown `range`.

### `GET /api/sensors/{id}/export.csv` — CSV download

Same `range` parameter. Returns `text/csv` with
`Content-Disposition: attachment`, one row per stored frame, oldest first, not
thinned (capped at 250 000 rows; `X-Truncated: true` if the cap was hit).

```csv
time_utc,epoch_ms,temp1C,temp2C,temp3C,temp4C,humidity1Pct,humidity2Pct,dhtTempC,dht2TempC,maxTempC,sensorsOk,rssiDbm
2026-09-29T10:25:46.109Z,1790677546109,24.7,24.8,23.5,26.5,58.3,60.7,24.8,25.1,26.5,6,-58
2026-09-29T10:25:46.431Z,1790677546431,24.7,25.2,23.9,,58.5,,24.8,,25.2,4,-59
```

### `GET /api/sensors/{id}/settings` · `PATCH /api/sensors/{id}/settings`

| Field | Type | Rules |
| --- | --- | --- |
| `tempHighC`, `tempLowC` | number \| null | −55–300; applies to T1–T4. `null` removes the limit |
| `humidityHighPct`, `humidityLowPct` | number \| null | 0–100; applies to H1 and H2. `null` removes the limit |
| `labels` | object | keys `t1` `t2` `t3` `t4` `h1` `h2`, values ≤ 40 chars. `null` or `""` restores the default name |

Absent fields are left alone. A low limit must be below its high limit.
Response: `{ "settings": SensorSettings }`.

```bash
curl -X PATCH http://localhost:3000/api/sensors/$ID/settings \
  -H "Content-Type: application/json" -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"tempHighC":30,"tempLowC":15,"labels":{"t1":"Cold room","h2":"Store"}}'
```

### `GET /api/sensors/{id}/alerts` — threshold alerts

| Query | Values | Default |
| --- | --- | --- |
| `open` | `true` \| `false` | both |
| `limit` | 1–200 | 100 |

`SensorAlert`: `id`, `deviceId`, `sensor` (`t1`…`h2`), `kind` (`temp_high`,
`temp_low`, `humidity_high`, `humidity_low`), `message`, `value`, `threshold`,
`raisedAt`, `clearedAt`.

Each frame is measured against the thresholds on ingest. A reading that stays
out of range is **one** alert whose `raisedAt` is when it started; it clears on
the first frame that is back inside the limits or has no reading for that
sensor. Sensor alerts are kept in their own table and do not appear in
`GET /api/alerts` or the fleet counters.

### Trying it without hardware

```bash
# a fake board: registers, then posts a frame every 5 s until Ctrl-C
node scripts/simulate-temphum.mjs http://localhost:3000 "$ADMIN_KEY"
node scripts/simulate-temphum.mjs http://localhost:3000 "$ADMIN_KEY" --missing   # T4 and H2 null
```

```bash
# register
curl -X POST http://localhost:3000/api/devices \
  -H "Content-Type: application/json" -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"name":"Temp-Hum A1B2C3","serialNumber":"TH-VER1-A1B2C3","firmwareVersion":"1.0.0","model":"TEMP-HUM Ver1","bluetoothName":"HEATER_VER1_TH_A1B2C3","homeSsid":"MyWiFi","localAddress":"http://192.168.1.50"}'

# one frame (ID and DEVICE_KEY come from the response above)
curl -X POST http://localhost:3000/api/devices/$ID/telemetry \
  -H "Content-Type: application/json" -H "X-Device-Key: $DEVICE_KEY" -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"level":"off","levelValue":0,"manual":false,"autoFan":false,"tripped":false,"climate":false,"totalCurrentA":0,"sumCurrentA":0,"totalPowerW":0,"readingSource":"ct","temp1C":24.6,"temp2C":25.1,"temp3C":23.8,"temp4C":null,"maxTempC":25.1,"humidity1Pct":58.2,"humidity2Pct":61.0,"dhtTempC":24.9,"dht2TempC":25.3,"sensorsOk":5,"deviceType":"temphum","wifi":"STA","ip":"192.168.1.50","bluetoothClient":false,"apiKeySet":false,"uptimeSeconds":3600,"rssi":-58,"channels":[]}'
```

---

## Firmware endpoints

A **release** is an uploaded `.bin` with a version string, scoped to a device
model. It moves through three states:

| Status | Meaning |
| --- | --- |
| `draft` | Uploaded; visible only in the portal. Devices cannot fetch it |
| `published` | Devices may download it by version |
| `current` | The one published release per model the fleet should run. What a device is handed when it asks for an update, and what a roll-out sends the fleet to |

Rules enforced by the API: a draft cannot be made current or rolled out;
the current release cannot be withdrawn or deleted until another release is
made current; `(model, version)` is unique. The image is stored in Postgres
and its SHA-256 is computed on upload and sent on every download.

### `FirmwareRelease` object

```
id, model, version, filename, sizeBytes, sha256, notes,
status ("draft" | "published" | "current"), isCurrent,
publishedAt, uploadedBy, createdAt, updatedAt,
deviceCount            // devices of this model currently reporting this version
```

### `GET /api/firmware` — list releases

**Auth** admin. **Query** `model` (optional, exact match).

**Response** `{ "releases": [ FirmwareRelease, … ] }` — current first, then newest.

### `POST /api/firmware` — upload a release

**Auth** admin. **Content type** `multipart/form-data` (not JSON).

| Form field | Type | Required | Rules |
| --- | --- | --- | --- |
| `file` | file | **yes** | The `.bin` image, 1 byte – 8 MB |
| `version` | text | **yes** | `1.2.3`, optional `v` prefix, optional `-rc1` / `+build` suffix, ≤ 64 chars |
| `model` | text | no | ≤ 64 chars, default `HEATER Ver1` |
| `notes` | text | no | ≤ 2000 chars |
| `publish` | text | no | `true` / `1` / `on` — publish immediately |
| `makeCurrent` | text | no | `true` / `1` / `on` — publish **and** make current, demoting the previous current release |
| `userId` | text | no | UUID recorded as `uploadedBy` |

**Response** `201 Created` `{ "release": FirmwareRelease }`

**Errors** `400` not multipart / no file · `409` version already exists for
the model · `413` too large · `422` bad version or field.

```bash
curl -X POST http://localhost:3000/api/firmware \
  -H "X-Admin-Key: $HEATER_ADMIN_KEY" \
  -F "file=@build/heater-1.2.0.bin" -F "version=1.2.0" \
  -F "notes=Fixes fan hysteresis" -F "publish=true" -F "makeCurrent=true"
```

### `GET /api/firmware/{id}` — one release

**Response** `{ "release": FirmwareRelease }` · **Errors** `404`.

### `PATCH /api/firmware/{id}` — lifecycle and notes

**Body** (JSON; `action` and/or `notes`)

| Field | Type | Rules |
| --- | --- | --- |
| `action` | enum | `publish` \| `set_current` \| `unpublish` |
| `makeCurrent` | boolean | With `publish`: also make current |
| `notes` | string \| null | ≤ 2000 chars |

**Response** `{ "release": FirmwareRelease }`

**Errors** `404` · `409` set_current on a draft, unpublish of the current
release · `422` no action or notes supplied.

```bash
curl -X PATCH http://localhost:3000/api/firmware/$RELEASE_ID \
  -H "X-Admin-Key: $HEATER_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action":"publish","makeCurrent":true}'
```

### `DELETE /api/firmware/{id}`

**Response** `{ "removed": true, "id" }` · **Errors** `404` · `409` release is current.

### `GET /api/firmware/{id}/download` — operator download

**Auth** admin. Responds with the raw image:

```http
Content-Type: application/octet-stream
Content-Length: <bytes>
Content-Disposition: attachment; filename="heater-1.2.0.bin"
X-Firmware-Model: HEATER Ver1
X-Firmware-Version: 1.2.0
X-Firmware-Sha256: <64 hex chars>
```

### `POST /api/firmware/{id}/rollout` — update the fleet

Queues the command `FIRMWARE_UPDATE <version>` for every device of the
release's model that is not already reporting that version. Offline devices
are included; they collect the command when they reconnect. The release must
be published.

**Body** (optional JSON)

| Field | Type | Rules |
| --- | --- | --- |
| `deviceIds` | string[] | Restrict the roll-out to these devices |
| `issuedBy` | string | User UUID recorded on each command |

**Response** `202 Accepted`

```json
{
  "release": FirmwareRelease,
  "command": "FIRMWARE_UPDATE 1.2.0",
  "queued": [ { "deviceId", "name", "commandId", "online" }, … ],
  "alreadyCurrent": 3,
  "otherModel": 0
}
```

**Errors** `404` · `409` release not published · `422` bad `deviceIds`.

### `GET /api/firmware/current` — mobile update check

> Standalone guide for the mobile team, with the download URL format and
> sample code: [`docs/mobile-firmware-update.md`](mobile-firmware-update.md).

**Auth** app key (`X-App-Key`), or admin. Model-scoped: no device id or
device key needed, so the app can check before pairing or on behalf of a board
it reaches only over Bluetooth.

**Query**

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `HEATER Ver1` | Device model, 1–64 chars |
| `version` | string | — | The version the board reports. When given, `updateAvailable` says whether it differs from the current release |

**Response**

```json
{
  "model": "HEATER Ver1",
  "reportedVersion": "1.0.0",
  "updateAvailable": true,
  "current": FirmwareRelease | null,
  "downloadPath": "/api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0",
  "downloadUrl":  "https://<host>/api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0",
  "published": [
    { "version": "1.1.0", "status": "current",   "sizeBytes": 320001, "sha256": "…", "notes": "…", "publishedAt": 1788946390193, "downloadPath": "…" },
    { "version": "1.0.0", "status": "published", "sizeBytes": 300001, "sha256": "…", "notes": "…", "publishedAt": 1788946300000, "downloadPath": "…" }
  ],
  "t": 1788946400000
}
```

`current` is `null` and `updateAvailable` is `false` when no release has been
marked current for the model. Drafts never appear in `published`.

```bash
curl -H "X-App-Key: $HEATER_APP_KEY" \
  "http://localhost:3000/api/firmware/current?model=HEATER%20Ver1&version=1.0.0"
```

### `GET /api/firmware/current/download` — mobile image download

**Auth** app key, or admin. `HEAD` returns the same headers without a body,
so the app can learn size and hash before committing to a transfer.

**Query** `model` (default `HEATER Ver1`), `version` (optional: a specific
*published* version; otherwise the current release).

**Request headers (optional)**

| Header | Effect |
| --- | --- |
| `Range: bytes=start-end` | One range; `206 Partial Content` with `Content-Range`. Use it to relay in chunks over Bluetooth and to resume |
| `If-None-Match: "<sha256>"` | `304 Not Modified` when the app already holds this image |

**Response headers**

```http
Content-Type: application/octet-stream
Content-Length: <bytes in this response>
Content-Disposition: attachment; filename="heater-1.1.0.bin"
Accept-Ranges: bytes
ETag: "<sha256>"
X-Firmware-Model: HEATER Ver1
X-Firmware-Version: 1.1.0
X-Firmware-Sha256: <64 hex chars>
X-Firmware-Size: <total bytes of the image>
```

**Errors** `401` bad app key · `404` no current release, or no published
release of that version · `416` unsatisfiable range · `422` bad model.

```bash
# full image
curl -H "X-App-Key: $HEATER_APP_KEY" -o heater.bin \
  "http://localhost:3000/api/firmware/current/download?model=HEATER%20Ver1"

# first 64 KB
curl -H "X-App-Key: $HEATER_APP_KEY" -H "Range: bytes=0-65535" -o part1.bin \
  "http://localhost:3000/api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0"
```

**Mobile update flow**

1. `GET /api/firmware/current?model=…&version=<board's version>`.
2. If `updateAvailable`, show the release notes and ask the user.
3. `GET …/current/download?model=…&version=<current.version>`, in one go or
   in ranges. Verify the SHA-256 against `X-Firmware-Sha256`.
4. Relay the image to the board over Wi-Fi or Bluetooth using the board's own
   OTA mechanism, then have the board re-register with its new `firmwareVersion`.

### `GET /api/devices/{id}/firmware` — update check (device)

**Auth** the device's own key, or admin. Answers from the current release for
the device's model.

```json
{
  "model": "HEATER Ver1",
  "reportedVersion": "1.0.0",
  "updateAvailable": true,
  "release": FirmwareRelease | null,
  "downloadPath": "/api/devices/<id>/firmware/download"
}
```

### `GET /api/devices/{id}/firmware/download` — device download

**Auth** the device's own key, or admin. **Query** `version` (optional): a
specific *published* version, as named in the `FIRMWARE_UPDATE` command.
Without it, the current release. Drafts are never served. Same headers as the
operator download; verify `X-Firmware-Sha256` before committing the partition.

**Errors** `401` / `403` credentials · `404` device, no current release, or
no published release of that version.

**Device update flow**

1. Board receives `FIRMWARE_UPDATE 1.2.0` in a telemetry or heartbeat response.
2. `GET /api/devices/{id}/firmware/download?version=1.2.0` with `X-Device-Key`.
3. Stream the body into the OTA partition, hashing as it goes; compare with
   `X-Firmware-Sha256`. Abort on mismatch.
4. `PATCH /api/devices/{id}/commands` with `{"commandId", "status":"acked"}`
   (or `"failed"` with `error`).
5. Reboot, then re-register with the new `firmwareVersion` so the portal's
   adoption count moves.

---

## Request log

Every call to any `/api` route is recorded in the `api_requests` table and
echoed to the server console as one line:

```
[api] POST /api/devices/<id>/telemetry 200 12ms credential=device
[api] POST /api/devices/<id>/telemetry 422 9ms credential=device - "level" must be one of: off, low, medium, high
```

Each row holds the method, the route pattern (`/api/devices/[id]/telemetry`,
so calls group regardless of device id), the concrete path and query string,
status, duration, the **kind of credential presented** (`admin`, `device`,
`app`, `provisioning`, `bearer`, `none` — what was sent, not whether it was
valid), the device id from the path when there is one, client IP, user agent,
and the error message for failures. Rows are written after the response is
sent and never block a request. Rows older than the retention window are
pruned automatically. Logging is on by default; see the environment table.

### `GET /api/logs` — read the log

**Auth** admin.

**Query**

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `view` | enum | `summary` | `summary` = one row per method+route with counts; `calls` = individual requests, newest first |
| `range`, `from`, `to` | | `24h` | Window, see [Time ranges](#time-ranges) |
| `credential` | enum | — | `admin` \| `device` \| `app` \| `provisioning` \| `bearer` \| `none` |
| `deviceId` | UUID | — | Calls whose path named this device (kept after the device is deleted) |
| `route` | string | — | `calls` only. Exact route pattern, e.g. `/api/devices/[id]/telemetry` |
| `method` | string | — | `calls` only |
| `status` | integer | — | `calls` only. Exact status |
| `failed` | boolean | — | `calls` only. `true` = status ≥ 400 |
| `limit` | integer | `100` | `calls` only, max 1000 |

**Response — summary**

```json
{
  "range": "24h", "from": …, "to": …,
  "calls": 12, "failed": 5,
  "routes": [
    { "method": "POST", "route": "/api/devices/[id]/telemetry", "calls": 3, "failed": 2,
      "avgDurationMs": 69, "maxDurationMs": 192, "lastCalledAt": …, "lastStatus": 403 },
    …
  ]
}
```

**Response — calls**

```json
{
  "range": "24h", "from": …, "to": …,
  "calls": [
    { "id": 41, "method": "POST", "route": "/api/devices/[id]/telemetry",
      "path": "/api/devices/4b23…/telemetry", "query": null, "status": 422, "durationMs": 9,
      "credential": "device", "deviceId": "4b23…", "deviceName": "Living Room Heater",
      "ip": "192.168.1.50", "userAgent": "HEATER-Ver1/1.0.0 esp32",
      "error": "\"level\" must be one of: off, low, medium, high", "createdAt": … }
  ]
}
```

```bash
# Has any device posted telemetry in the last hour, and did it succeed?
curl -H "X-Admin-Key: $HEATER_ADMIN_KEY" \
  "http://localhost:3000/api/logs?view=calls&route=/api/devices/[id]/telemetry&range=custom&from=$(( $(date +%s%3N) - 3600000 ))&to=$(date +%s%3N)"

# Everything that failed today
curl -H "X-Admin-Key: $HEATER_ADMIN_KEY" "http://localhost:3000/api/logs?view=calls&failed=true&range=today"
```

---

## Browser sign-in

Two routes exist only for the dashboard itself; scripts and firmware use the
header forms above instead.

### `POST /api/auth/login`

**Body** `{ "key": "<HEATER_ADMIN_KEY>" }`

Verifies the key and, on success, sets the `heater_admin` cookie (httpOnly,
30 days) that every admin route in this document also accepts. There is no
session store - the cookie carries the key itself, exactly like `X-Admin-Key`
does for a script.

**Response** `200` `{ "authenticated": true }`

**Errors** `401` wrong key · `409` `HEATER_ADMIN_KEY` is not set, so there is
nothing to sign in to · `422` missing `key`.

### `POST /api/auth/logout`

Clears the cookie. **Response** `200` `{ "authenticated": false }`. No body, no auth required.

Every page under the dashboard (`/`, `/devices`, `/alerts`, `/firmware`, …)
redirects to `/login` server-side when `HEATER_ADMIN_KEY` is set and the
cookie is missing or wrong, so a signed-out browser never reaches a page whose
buttons would 401.

---

## Public endpoints

### `GET /api/health`

No auth. `200` when healthy, `503` when degraded.

```json
{
  "status": "ok",
  "database": { "connected": true, "name": "heaterfan", "schemaComplete": true, "missingTables": [] },
  "adminAuthConfigured": true,
  "t": 1788946203357
}
```

---

## Shared types

### Enums

| Name | Values |
| --- | --- |
| `HeatLevel` | `off`, `low`, `medium`, `high` |
| `WifiMode` | `AP`, `STA` |
| `FaultCode` | `ok`, `over_current`, `no_load`, `over_temperature` |
| `AlertSeverity` | `info`, `warning`, `critical` |
| `CommandStatus` | `pending`, `delivered`, `acked`, `failed`, `expired` |
| `ChannelKind` | `heater`, `fan`, `light` |
| `SignalQuality` | `excellent`, `good`, `fair`, `weak`, `unusable` |

### Time ranges

Used by `history`, `energy` and `alerts`.

| `range` | Window |
| --- | --- |
| `today` | the whole calendar day in the display timezone (`NEXT_PUBLIC_HEATER_TIMEZONE`, default Asia/Kolkata): 00:00 → 24:00. `to` is in the future until midnight |
| `24h` (default) | now − 24 h → now |
| `7d` | now − 7 d → now |
| `30d` | now − 30 d → now |
| `custom` | `from` → `to`, both epoch ms, `from < to`. Falls back to `24h` if unusable |

### `DeviceView`

Returned by every device read and inside stream messages.

```
id, name, model, serialNumber, firmwareVersion, bluetoothName, bluetoothAddress,
homeSsid, localAddress, remoteAddress, roomId, roomName, roomIcon, homeName,
homeTimezone, createdAt,
status, online, offlineReason, lastSeenAt, dataAgeMs, stale,
signal: { rssiDbm, quality, label, bars, percent, reason },
telemetry: TelemetryFrame | null,       // latest frame, all fields as posted, plus recordedAt
channels: [ { channelIndex, channelId, name, kind, relayPin, ctPin, calibration,
              enabled, reading: { isOn, currentA, powerW, energyWh, fault } | null, active } ],
settings: DeviceSettings | null,
hottestTempC, averageHumidityPct, heating, anyChannelOn, faultCount,
openAlertCount, worstAlertSeverity, tripped
```

### `DeviceSettings`

```
deviceId, currentLimitA, totalLimitA, temperatureLimitC, mainsVoltageV,
autoFan, climateEnabled, climateTargetC, irSlots, updatedAt
```

### `DeviceCommand`

```
id, deviceId, issuedBy, command, status, reply, error,
createdAt, deliveredAt, completedAt, expiresAt
```

### `DeviceAlert`

```
id, deviceId, deviceName, channelIndex, channelId, code, severity, message,
value, raisedAt, clearedAt, acknowledgedAt, acknowledgedBy
```

---

## Environment variables

| Variable | Default | Effect on the API |
| --- | --- | --- |
| `HEATER_ADMIN_KEY` | unset (open) | Secret for every admin route and `/api/events` |
| `HEATER_PROVISIONING_KEY` | unset (open) | Secret for `POST /api/devices` |
| `HEATER_APP_KEY` | unset (open) | Secret the mobile app presents to `/api/firmware/current[/download]` |
| `HEATER_CORS_ORIGINS` | `*` | Origins allowed to call `/api` from a browser. `*` = all. Comma-separated list to restrict, e.g. `https://app.example.com,https://ops.example.com` |
| `HEATER_API_LOG` | `on` | Record every API call in `api_requests`. `off` disables both the table and the console line |
| `HEATER_API_LOG_CONSOLE` | `on` | Print the `[api] …` line per call to the server console |
| `HEATER_API_LOG_RETENTION_MS` | 7 days | Log rows older than this are pruned (checked at most hourly) |
| `HEATER_TELEMETRY_INTERVAL_MS` | `15000` | Returned as `nextIntervalMs` |
| `HEATER_OFFLINE_TIMEOUT_MS` | `45000` | Silence before a device is marked offline |
| `HEATER_SENSOR_OFFLINE_TIMEOUT_MS` | `60000` | Silence before a temperature / humidity sensor board is marked offline |
| `HEATER_STALE_DATA_MS` | `20000` | Frame age before `stale: true` |
| `HEATER_SSE_KEEPALIVE_MS` | `20000` | Keep-alive comment interval on `/api/events` |
| `HEATER_HISTORY_MAX_SAMPLES` | `2000` | Cap on telemetry points per history call |
| `HEATER_SIM` | `on` | Built-in simulator posts frames through the same ingest path. Set `HEATER_SIM=off` before pointing real hardware at the API |
| `DATABASE_URL` | `postgresql://heater@localhost:5432/heaterfan` | Postgres connection |

A device can only be registered when at least one row exists in `homes` (and a
`users` row to own it). A fresh database built from `db/schema.sql` has neither;
insert them before the first `POST /api/devices` or the call returns `409`.
