# Firmware update — mobile app guide

How the HEATER Ver1 mobile app checks for a new firmware version and downloads
the image. Two endpoints, one header. Everything else in the portal's API is
for the admin dashboard or the board itself and the app does not need it.

- [Base URL and authentication](#base-url-and-authentication)
- [1. Check the current version](#1-check-the-current-version)
- [2. Download the firmware](#2-download-the-firmware)
- [Download URL reference](#download-url-reference)
- [Recommended flow](#recommended-flow)
- [Errors](#errors)
- [Sample code](#sample-code)
- [Testing against a local portal](#testing-against-a-local-portal)

---

## Base URL and authentication

| | |
| --- | --- |
| **Base URL** | `https://<portal-host>/api` — in development `http://localhost:3000/api` |
| **Header** | `X-App-Key: <HEATER_APP_KEY>` (or `Authorization: Bearer <HEATER_APP_KEY>`) |
| **Content type** | Both endpoints are `GET`; no request body |
| **Timestamps** | Unix epoch **milliseconds** |

The app key is the value of the portal's `HEATER_APP_KEY` environment
variable. Ask the portal operator for it. When the portal has no
`HEATER_APP_KEY` set (a development install), the header is not required and
any value is accepted.

Wrong or missing key when one is configured:

```json
HTTP 401
{ "error": "Invalid app key" }
```

---

## 1. Check the current version

```http
GET /api/firmware/current?model=HEATER%20Ver1&version=1.0.0
X-App-Key: <HEATER_APP_KEY>
```

**Query parameters**

| Param | Required | Default | Meaning |
| --- | --- | --- | --- |
| `model` | no | `HEATER Ver1` | Device model. URL-encode the space: `HEATER%20Ver1` |
| `version` | no | — | The firmware version the board reports (from its Bluetooth/Wi-Fi info, or the last value the app saw). When supplied, `updateAvailable` is computed for you |

**Response `200`**

```json
{
  "model": "HEATER Ver1",
  "reportedVersion": "1.0.0",
  "updateAvailable": true,
  "current": {
    "id": "936a5881-7148-4369-833c-19318cb6aa91",
    "model": "HEATER Ver1",
    "version": "1.1.0",
    "filename": "heater-1.1.0.bin",
    "sizeBytes": 320001,
    "sha256": "08a6a571fb4e379bc6446610d4e2fbdea29dd75b08107c9b7e3bd01de9d6cee9",
    "notes": "Fixes fan hysteresis. Adds over-temperature latch.",
    "status": "current",
    "isCurrent": true,
    "publishedAt": 1788946390193,
    "uploadedBy": null,
    "createdAt": 1788946390193,
    "updatedAt": 1788946390193,
    "deviceCount": 12
  },
  "downloadPath": "/api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0",
  "downloadUrl": "https://<portal-host>/api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0",
  "published": [
    {
      "version": "1.1.0",
      "status": "current",
      "sizeBytes": 320001,
      "sha256": "08a6a571…",
      "notes": "Fixes fan hysteresis. Adds over-temperature latch.",
      "publishedAt": 1788946390193,
      "downloadPath": "/api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0"
    },
    {
      "version": "1.0.0",
      "status": "published",
      "sizeBytes": 300001,
      "sha256": "ffa666aa…",
      "notes": "First release",
      "publishedAt": 1788946300000,
      "downloadPath": "/api/firmware/current/download?model=HEATER%20Ver1&version=1.0.0"
    }
  ],
  "t": 1788946400000
}
```

**Fields the app should use**

| Field | Use |
| --- | --- |
| `updateAvailable` | `true` when `current.version` differs from the `version` you passed. It is a plain string comparison, so it is also `true` for a board on a *newer* test build; compare versions yourself if that matters |
| `current` | The release the fleet should run. `null` when the operator has not marked one current — show "no update available" |
| `current.version` | Show to the user and pass as `version` on download |
| `current.sizeBytes` | For the progress bar |
| `current.sha256` | Verify the downloaded bytes before sending anything to the board |
| `current.notes` | Release notes to show before the user confirms |
| `downloadUrl` | **Absolute URL, ready to fetch.** Built from the host the request came in on |
| `downloadPath` | The same, relative to the base URL. Use this if the app already has a configured host |
| `published` | Every version the operator has published, newest first. Only needed if the app offers a choice of versions |

Drafts that the operator has uploaded but not published never appear in this
response and cannot be downloaded.

**When nothing is current**

```json
{
  "model": "HEATER Ver1",
  "reportedVersion": "1.0.0",
  "updateAvailable": false,
  "current": null,
  "downloadPath": null,
  "downloadUrl": null,
  "published": [],
  "t": 1788946400000
}
```

---

## 2. Download the firmware

```http
GET /api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0
X-App-Key: <HEATER_APP_KEY>
```

**Query parameters**

| Param | Required | Default | Meaning |
| --- | --- | --- | --- |
| `model` | no | `HEATER Ver1` | Device model |
| `version` | no | current release | A specific **published** version. Always pass the `current.version` you just showed the user, so the bytes you download are the bytes they agreed to, even if the operator changes the current release meanwhile |

**Response `200`** — the body is the raw `.bin` image.

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: 320001
Content-Disposition: attachment; filename="heater-1.1.0.bin"
Accept-Ranges: bytes
ETag: "08a6a571fb4e379bc6446610d4e2fbdea29dd75b08107c9b7e3bd01de9d6cee9"
X-Firmware-Model: HEATER Ver1
X-Firmware-Version: 1.1.0
X-Firmware-Sha256: 08a6a571fb4e379bc6446610d4e2fbdea29dd75b08107c9b7e3bd01de9d6cee9
X-Firmware-Size: 320001
```

**`HEAD`** on the same URL returns these headers and no body. Use it to get
size and hash before committing to a transfer on mobile data.

**Chunked download and resume** — send a `Range` header. One range per
request. The response is `206` with the byte range served:

```http
GET /api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0
X-App-Key: <HEATER_APP_KEY>
Range: bytes=0-65535

HTTP/1.1 206 Partial Content
Content-Range: bytes 0-65535/320001
Content-Length: 65536
X-Firmware-Size: 320001
```

`bytes=65536-` fetches from an offset to the end; `bytes=-1024` fetches the
last 1024 bytes. A range outside the file returns `416`.

**Already have it** — send `If-None-Match: "<sha256>"` (with the quotes) and
the portal answers `304 Not Modified` with no body when the image is unchanged.

**Verify before use.** Compute SHA-256 over the complete image and compare with
`X-Firmware-Sha256` (identical to `current.sha256` from step 1). Discard on
mismatch. Never forward an unverified image to the board.

---

## Download URL reference

The URL has a fixed shape, so the app can build it itself or take it verbatim
from `downloadUrl` in the version check.

```
https://<portal-host>/api/firmware/current/download?model=<model>&version=<version>
```

| Part | Value |
| --- | --- |
| `<portal-host>` | The portal's public host name. In development `localhost:3000` over `http` |
| `model` | URL-encoded model, e.g. `HEATER%20Ver1`. Omit for the default model |
| `version` | The exact version string from `current.version`, e.g. `1.1.0`. Omit to get whatever is current at the moment of the request |

Examples:

```
https://<portal-host>/api/firmware/current/download                                  # current release, default model
https://<portal-host>/api/firmware/current/download?version=1.1.0                    # a specific published version
https://<portal-host>/api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0
```

The URL is stable. It does not embed a release id, so the same link keeps
working after the operator re-uploads or re-orders releases, and it can be
shown to a user or logged safely. It still requires the `X-App-Key` header, so
it is not a link that opens in a plain browser once the key is configured.

---

## Recommended flow

1. **Read the board's version.** From its BLE advertisement / info
   characteristic, or from the last telemetry the app relayed.
2. **Check.** `GET /api/firmware/current?model=…&version=<board version>`.
3. **Decide.** If `current` is `null` or `updateAvailable` is `false`, tell the
   user they are up to date and stop.
4. **Confirm.** Show `current.version`, `current.notes` and the size. Wait for
   the user.
5. **Download.** `GET` the `downloadUrl` (or build it with `version=current.version`).
   Use `Range` in chunks if you relay over Bluetooth, or fetch whole if the
   board is on Wi-Fi.
6. **Verify.** SHA-256 of the full image equals `X-Firmware-Sha256`.
7. **Flash.** Hand the image to the board over its OTA path (Wi-Fi local
   endpoint or BLE transfer — see the firmware team's guide).
8. **Confirm.** After the board reboots, read its version again. The board
   re-registers with the portal on boot and reports the new
   `firmwareVersion`; the portal's adoption figures update from that, not
   from the download.

Note that the operator can also push an update without the app: a roll-out
from the portal queues a `FIRMWARE_UPDATE <version>` command that the board
collects on its next telemetry or heartbeat round trip, then downloads with
its own device key. The app flow above is for boards reachable only over
Bluetooth, and for letting the user choose when to update.

---

## Errors

All errors are JSON: `{ "error": "<message>" }`.

| Status | Endpoint | Cause | App behaviour |
| --- | --- | --- | --- |
| `401` | both | Missing or wrong `X-App-Key` | Configuration problem; do not retry in a loop |
| `404` | download | No current release for the model, or the requested `version` is not published | Re-run the version check; the operator may have withdrawn the release |
| `416` | download | `Range` outside the file | Restart the download from `bytes=0-` |
| `422` | both | `model` empty or longer than 64 chars | Fix the request |
| `304` | download | `If-None-Match` matched | Use the copy you have |

---

## Sample code

**Kotlin (OkHttp)**

```kotlin
val client = OkHttpClient()
val base = "https://<portal-host>"
val appKey = BuildConfig.HEATER_APP_KEY

fun checkForUpdate(boardVersion: String): JSONObject {
    val url = "$base/api/firmware/current?model=HEATER%20Ver1&version=$boardVersion"
    val req = Request.Builder().url(url).header("X-App-Key", appKey).build()
    client.newCall(req).execute().use { res ->
        check(res.isSuccessful) { "check failed: ${res.code}" }
        return JSONObject(res.body!!.string())
    }
}

fun downloadFirmware(downloadUrl: String, expectedSha256: String): ByteArray {
    val req = Request.Builder().url(downloadUrl).header("X-App-Key", appKey).build()
    client.newCall(req).execute().use { res ->
        check(res.isSuccessful) { "download failed: ${res.code}" }
        val bytes = res.body!!.bytes()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
        check(digest == expectedSha256) { "firmware hash mismatch" }
        return bytes
    }
}

// usage
val info = checkForUpdate(boardVersion = "1.0.0")
if (info.getBoolean("updateAvailable")) {
    val current = info.getJSONObject("current")
    val image = downloadFirmware(info.getString("downloadUrl"), current.getString("sha256"))
    // relay `image` to the board
}
```

**Swift (URLSession)**

```swift
let base = URL(string: "https://<portal-host>")!
let appKey = "<HEATER_APP_KEY>"

func checkForUpdate(boardVersion: String) async throws -> [String: Any] {
    var comps = URLComponents(url: base.appendingPathComponent("/api/firmware/current"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [.init(name: "model", value: "HEATER Ver1"), .init(name: "version", value: boardVersion)]
    var req = URLRequest(url: comps.url!)
    req.setValue(appKey, forHTTPHeaderField: "X-App-Key")
    let (data, res) = try await URLSession.shared.data(for: req)
    guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    return try JSONSerialization.jsonObject(with: data) as! [String: Any]
}

func downloadFirmware(_ urlString: String, expectedSha256: String) async throws -> Data {
    var req = URLRequest(url: URL(string: urlString)!)
    req.setValue(appKey, forHTTPHeaderField: "X-App-Key")
    let (data, res) = try await URLSession.shared.data(for: req)
    guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard digest == expectedSha256 else { throw URLError(.cannotDecodeContentData) }
    return data
}
```

**JavaScript / React Native (fetch)**

```js
const BASE = "https://<portal-host>";
const APP_KEY = "<HEATER_APP_KEY>";

export async function checkForUpdate(boardVersion) {
  const url = `${BASE}/api/firmware/current?model=${encodeURIComponent("HEATER Ver1")}&version=${encodeURIComponent(boardVersion)}`;
  const res = await fetch(url, { headers: { "X-App-Key": APP_KEY } });
  if (!res.ok) throw new Error(`check failed: ${res.status}`);
  return res.json(); // { updateAvailable, current, downloadUrl, ... }
}

export async function downloadFirmware(downloadUrl, expectedSha256) {
  const res = await fetch(downloadUrl, { headers: { "X-App-Key": APP_KEY } });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // hash with your platform's crypto (e.g. expo-crypto / react-native-quick-crypto)
  if ((await sha256Hex(bytes)) !== expectedSha256) throw new Error("firmware hash mismatch");
  return bytes;
}
```

**curl**

```bash
# 1. check
curl -H "X-App-Key: $HEATER_APP_KEY" \
  "https://<portal-host>/api/firmware/current?model=HEATER%20Ver1&version=1.0.0"

# 2. download the version the check returned
curl -H "X-App-Key: $HEATER_APP_KEY" -o heater-1.1.0.bin \
  "https://<portal-host>/api/firmware/current/download?model=HEATER%20Ver1&version=1.1.0"

# 3. verify
sha256sum heater-1.1.0.bin
```

---

## Testing against a local portal

1. Start the portal (`npm run dev`) and open **Firmware** in the dashboard.
2. Upload a `.bin`, choose **Publish & make current**.
3. From the app or curl, hit `http://localhost:3000/api/firmware/current`.
   Without `HEATER_APP_KEY` in the portal's `.env.local` no header is needed;
   add the variable and restart to test the authenticated path.
4. Every call the app makes appears in the portal's request log
   (`GET /api/logs?view=calls&credential=app` with an admin key), which is the
   quickest way to confirm the app is reaching the server and with what result.
