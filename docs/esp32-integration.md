# HEATER Ver1 firmware integration

What the board owes the backend, and what it gets back. Every field below maps
to a column in the `heaterfan` schema — the dashboard shows nothing else, so
anything you add here that is not in the schema is silently dropped (it is still
kept verbatim in `telemetry.raw`).

## 1. Register once, keep the key

```http
POST /api/devices
Content-Type: application/json
X-Provisioning-Key: <HEATER_PROVISIONING_KEY, if set>

{
  "name": "Living Room Heater",
  "serialNumber": "HTR-VER1-000001",
  "firmwareVersion": "1.0.0",
  "bluetoothName": "HEATER_VER1",
  "homeSsid": "AuraHome-2G",
  "localAddress": "http://192.168.1.50"
}
```

The response carries `device.id` and `deviceKey`. **Store both in NVS.** Only
the SHA-256 of the key is kept server-side, so it cannot be recovered later — a
board that loses it has to re-register.

Re-registration is matched on `serialNumber`: a board that reboots after a
firmware update updates its row and keeps its history rather than appearing as a
second device. It also mints a fresh key, so always save the one you get back.
The board's name (`name` here, `deviceName` in each telemetry frame) is
followed until someone renames the device on the portal; from then on the
portal's name is kept.

If no channels are supplied, the standard six are created: `h1`–`h4` (heaters,
relays 25/15/2/4, CTs 36/39/34/35), `fan` (relay 18, CT 32) and `light`
(relay 19, CT 33).

## 2. Post a frame each cycle

```http
POST /api/devices/{id}/telemetry
Content-Type: application/json
X-Device-Key: <deviceKey>

{
  "level": "high",              // off | low | medium | high
  "levelValue": 3,
  "mode": "MANUAL",
  "manual": true,
  "autoFan": true,
  "tripped": false,

  "climate": false,
  "climateTargetC": 21.0,       // 10–60

  "totalCurrentA": 16.4,
  "sumCurrentA": 16.4,
  "totalPowerW": 3772,
  "readingSource": "CT SUM",
  "meterVoltageV": 230.1,
  "mainsVoltageV": 230,

  "temp1C": 78.4, "temp2C": 71.2, "temp3C": 24.1,
  "dhtTempC": 22.8, "maxTempC": 78.4,
  "humidity1Pct": 44.2, "humidity2Pct": 46.0, "humidity3Pct": 43.1,

  "currentLimitA": 12, "totalLimitA": 30, "temperatureLimitC": 85,

  "wifi": "STA",                // STA = joined home Wi-Fi, AP = own access point
  "ip": "192.168.1.50",
  "wifiRssiDbm": -58,           // WiFi.RSSI(), -120..0; omit if not measured
  "bleRssiDbm": -71,            // BLE peer RSSI, -120..0; omit if not measured
  "bluetoothClient": true,
  "apiKeySet": true,
  "uptimeSeconds": 3600,

  "channels": [
    { "channelIndex": 0, "isOn": true,  "currentA": 5.4, "powerW": 1242, "fault": "ok" },
    { "channelIndex": 4, "isOn": true,  "currentA": 0.4, "powerW": 92,   "fault": "no_load" }
  ]
}
```

Everything is optional — send what you have. `channelId` may be omitted; the
backend resolves it from the index against the device's configured channels.
Valid `fault` values are `ok`, `over_current`, `no_load`, `over_temperature`.

The response is the only thing you need to act on:

```json
{ "accepted": true, "receivedAt": 1788335271790, "nextIntervalMs": 15000,
  "ignoredFields": [],
  "commands": [ { "id": "…", "command": "SET LEVEL HIGH" } ] }
```

A temperature or humidity value outside the sensor's range (−55–300 °C,
0–100 %) is stored as "no reading" and named in `ignoredFields`; the rest of
the frame is still accepted. Still send `null` for a failed read where you can.

`commands` are yours the moment they are handed to you — they are marked
delivered atomically, so a second poll will not receive them again. Acknowledge
each one:

```http
PATCH /api/devices/{id}/commands
X-Device-Key: <deviceKey>

{ "commandId": "…", "status": "acked", "reply": "level set to high" }
```

Use `"status": "failed"` with an `error` when you could not carry it out. A
command not collected within two minutes expires on its own.

### Fan Temp Monitor (4x DS18B20, no relays)

The temperature-only board uses the same two endpoints. It registers as
`"name": "Fan Temp <deviceID>"` and each frame carries just the probe fields:

```json
{
  "temp1C": 24.1, "temp2C": 24.6, "temp3C": 23.9, "temp4C": 25.2,
  "avgTempC": 24.45, "maxTempC": 25.2,
  "temperatureLimitC": 60,
  "wifi": "STA", "ip": "192.168.1.61", "uptimeSeconds": 900
}
```

`temp4C` and `avgTempC` are nullable columns the HEATER Ver1 board simply
omits. `avgTempC` is stored as the board reported it, not recomputed. A probe
that fails to read (DS18B20 returns −127) is stored as `null` and named in
`ignoredFields`; the rest of the frame is still accepted. Probe order on a
shared 1-Wire bus is not stable across reboots unless the firmware pins each
probe to its hardware address, so "Probe 1" on the dashboard is whatever the
firmware calls sensor 1.

### TEMP-HUM Ver1 (4 probes + 2 humidity sensors, no relays)

Registers with `"model": "TEMP-HUM Ver1"` and stamps every frame with
`"deviceType": "temphum"`; either one is enough for the server to treat the
device as a sensor board. It is then shown on the portal's
**Temperature & Humidity** page instead of the heater list, and gets no relay
channels.

```json
{
  "temp1C": 24.6, "temp2C": 25.1, "temp3C": 23.8, "temp4C": null,
  "maxTempC": 25.1,
  "humidity1Pct": 58.2, "humidity2Pct": 61.0,
  "dhtTempC": 24.9, "dht2TempC": 25.3,
  "sensorsOk": 5, "deviceType": "temphum",
  "wifi": "STA", "ip": "192.168.1.50", "rssi": -58, "uptimeSeconds": 3600,
  "channels": []
}
```

Send `null` for a sensor that is missing or failed to read - never `0`, which
is a real temperature. The heater fields the firmware also sends (`level`,
`totalCurrentA`, ...) are accepted and ignored by the sensor page. The board is
shown as offline after 60 s without a frame. `scripts/simulate-temphum.mjs`
is a stand-in for the board; see `docs/api.md`.

## 3. Heartbeat when idle

An idle board still has to say it is alive, or the sweeper marks it offline
after `HEATER_OFFLINE_TIMEOUT_MS`:

```http
POST /api/devices/{id}/heartbeat
X-Device-Key: <deviceKey>
```

This only advances `last_seen_at`; it writes no telemetry row. Prefer it over
re-posting an unchanged frame — identical frames every fifteen seconds bury the
readings that mean something.

## Responses to handle

| Status | Meaning | What the firmware should do |
|---|---|---|
| `200` | Accepted | Apply any returned commands |
| `401` | No credentials presented | Check the `X-Device-Key` header is being sent |
| `403` | Wrong key, or unknown device | Re-register; do not retry in a tight loop |
| `404` | Device deleted | Re-register |
| `422` | A field is malformed | The body names the field — fix and do not retry as-is |

## Bluetooth

The board does not talk to this backend over BLE. When it is reachable only over
Bluetooth, the mobile app acts as the gateway: it reads the frame over BLE and
posts it to the same endpoint with the same device key, setting
`bluetoothClient: true` and `wifi: "AP"`.

The backend never infers proximity or range. It records what it is told —
Wi-Fi mode, IP, whether a client is attached, and the measured RSSI of each
radio. There is no distance threshold anywhere in this system, because usable
range depends on the antenna, the enclosure, obstacles and the phone's own
radio; only the measured value and the link state are ever stored.

`wifiRssiDbm` and `bleRssiDbm` are both optional. Firmware that omits them keeps
working exactly as before, and the dashboard shows "Not reported" for that link
rather than inventing a bar — a link that is up but unmeasured is deliberately
distinct from no link at all. When a value is present the dashboard buckets it
into Excellent / Good / Weak using the bands in `.env` and charts it over time.

## Reference sketch

```cpp
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* BASE = "http://192.168.1.10:3000";
String deviceId, deviceKey;   // loaded from NVS after registration

void postTelemetry() {
  JsonDocument doc;
  doc["level"]         = levelName();       // "off" | "low" | "medium" | "high"
  doc["levelValue"]    = levelValue;
  doc["mode"]          = modeName();
  doc["manual"]        = manualMode;
  doc["autoFan"]       = autoFan;
  doc["tripped"]       = protectionTripped;
  doc["totalCurrentA"] = totalCurrent;
  doc["totalPowerW"]   = totalCurrent * mainsVoltage;
  doc["mainsVoltageV"] = mainsVoltage;
  doc["temp1C"]        = probe1.readCelsius();
  doc["dhtTempC"]      = dht.readTemperature();
  doc["humidity1Pct"]  = dht.readHumidity();
  doc["wifi"]          = WiFi.getMode() == WIFI_AP ? "AP" : "STA";
  doc["ip"]            = WiFi.localIP().toString();
  // Real measurement, not a guess. Skip it in AP mode: the board *is* the
  // access point, so there is no peer signal to report.
  if (WiFi.getMode() != WIFI_AP) doc["wifiRssiDbm"] = WiFi.RSSI();
  doc["uptimeSeconds"] = millis() / 1000;

  JsonArray channels = doc["channels"].to<JsonArray>();
  for (int i = 0; i < 6; i++) {
    JsonObject c   = channels.add<JsonObject>();
    c["channelIndex"] = i;
    c["isOn"]         = relayState[i];
    c["currentA"]     = ctCurrent[i];
    c["powerW"]       = ctCurrent[i] * mainsVoltage;
    c["fault"]        = faultName(i);       // "ok" | "over_current" | "no_load" | "over_temperature"
  }

  HTTPClient http;
  http.begin(String(BASE) + "/api/devices/" + deviceId + "/telemetry");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", deviceKey);

  String body;
  serializeJson(doc, body);
  int status = http.POST(body);

  if (status == 200) {
    JsonDocument reply;
    deserializeJson(reply, http.getString());
    for (JsonObject command : reply["commands"].as<JsonArray>()) {
      applyCommand(command["command"].as<const char*>());
      acknowledge(command["id"].as<const char*>());
    }
  } else if (status == 403 || status == 404) {
    reRegister();                            // key rotated, or device removed
  }
  http.end();
}
```

## Alerting, and what the backend does for you

You do not need to send alerts. The ingest layer measures each frame against the
device's `device_settings` and raises them itself:

| Code | Raised when |
|---|---|
| `tripped` | `tripped` is true |
| `over_temperature` | the hottest probe exceeds `temperature_limit_c` |
| `total_over_current` | `totalCurrentA` exceeds `total_limit_a` |
| `total_current_high` | `totalCurrentA` passes 90% of `total_limit_a` |
| `channel_over_current` | a channel exceeds `current_limit_a` |
| `over_current` / `no_load` / `over_temperature` | a channel reports that `fault` |

An alert clears automatically when a frame arrives without the condition. Keep
sending `fault: "ok"` once a channel recovers — silence is not a recovery
signal, and the alert will stay open until a frame says otherwise.

## Firmware updates (OTA)

The portal's Firmware page holds every released image and marks one per model
as **current**. Rolling out queues an ordinary command for each outdated board:

```
FIRMWARE_UPDATE 1.2.0
```

It arrives in the `commands` array of a telemetry or heartbeat response like
any other command. On receiving it:

1. `GET /api/devices/{id}/firmware/download?version=1.2.0` with your
   `X-Device-Key`. The body is the raw `.bin`; `X-Firmware-Sha256` carries its
   digest and `Content-Length` its size. (`GET /api/devices/{id}/firmware`
   answers "is there an update for me?" if you would rather poll on boot.)
2. Stream the body into the inactive OTA partition (`esp_ota_write`), hashing
   as you go. Compare with `X-Firmware-Sha256`; abort and report `failed` on a
   mismatch rather than booting an image you cannot vouch for.
3. `PATCH /api/devices/{id}/commands` with `{"commandId": "...", "status": "acked"}`
   before rebooting, so the portal does not show the command as expired.
4. After reboot, re-register (section 1) with the new `firmwareVersion`. The
   version you report is the only thing the portal's adoption figures trust.
