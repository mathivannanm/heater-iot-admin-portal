/*
==========================================================================
HEATER Ver1 - ESP32-WROOM-32 FULL CONTROLLER FIRMWARE (+ API KEY)
==========================================================================

HARDWARE MAP
--------------------------------------------------------------------------
OUTPUT RELAY GPIO CT GPIO(ADC) DEVICE
O1 K1 25 CT1 36 HEATER 1
O2 K2 15 CT2 39 HEATER 2
O3 K3 2 CT3 34 HEATER 3
O4 K4 4 CT4 35 HEATER 4
O5 K5 18 CT5 32 FAN
O6 K6 19 CT6 33 LIGHT

IND1 = GPIO13 LOW level lamp
IND2 = GPIO12 MED level lamp
IND3 = GPIO14 HIGH level lamp
IND4 = GPIO27 STATUS lamp (WiFi/BT connected = ON, fault = blink)

DS18B20 #1 = GPIO21 (single probe)
DISPLAY TM1637 4-digit 7-segment: CLK = GPIO22 DIO = GPIO23
BUZZER = GPIO26
IR VS1838B = GPIO5
Energy meter (optional, UART) : RX=16 TX=17 @9600

LIBRARY NEEDED
--------------------------------------------------------------------------
"TM1637Display" by Avishay Orpaz (Library Manager - for the 4-digit display)

HEAT LEVEL LOGIC
--------------------------------------------------------------------------
OFF -> 0 heater
LOW -> 1 heater (H1)
MEDIUM -> 2 heaters (H1 + H2)
HIGH -> 4 heaters (H1 + H2 + H3 + H4)
FAN and LIGHT are independent ON/OFF (light only).

==========================================================================
FAN IS THE MASTER (NEW RULE)
--------------------------------------------------------------------------
  * NO FAN = NO HEATER. A heater relay is only ever switched ON while the
    fan relay is really ON.
  * "fan off" (Serial / BT / web / API / IR fan key) turns ALL heaters OFF
    first, cancels auto-comfort and any self-test, then the fan stops.
    Order on the relays: heaters OFF -> fan OFF (no run-on).
  * Turning heat ON (heat level, h1..h4, self-test, auto-comfort) turns the
    fan ON first. Order: fan ON -> fan runs 2 s -> heaters ON one at a time,
    2 s apart (limits inrush current).
  * Turning heat OFF ("heat off", auto-comfort reaching target, self-test end):
    heaters OFF -> fan keeps running 30 s to cool the elements -> fan OFF.
  * LIGHT switches immediately and never waits for the heaters.
  * A fan over-current fault switches every heater OFF and blocks them
    until "reset".
  * All timings are FAN_LEAD_MS / HEATER_STAGGER_MS / FAN_RUNON_MS in the
    RELAY CONTROL section.

AUTO-COMFORT DEFAULT + ON/OFF CONTROL
--------------------------------------------------------------------------
  * POWER-UP SAFE START: after a power cut / unplug, the board ALWAYS starts
    with every output OFF and auto-comfort OFF. Nothing heats until a person
    turns it on from the app, the IR remote, the dashboard or Serial.
  * Auto-comfort must be switched on by the user; the last target ("settemp") is
    saved to flash and loaded again at boot.
  * It can be switched ON/OFF any time from:
      - mobile app / web API : /api/cmd?c=climate+on  |  climate+off
      - web dashboard        : AUTO-COMFORT toggle button
      - IR remote            : learn slot 8 (AUTO-COMFORT TOGGLE)
      - Serial / Bluetooth   : climate on | climate off | climate (toggle)
  * "fan off" also switches auto-comfort OFF (fan is master); switch it
    back on with climate on.

CONTROL CHANNELS (all four accept the SAME commands)
--------------------------------------------------------------------------
1. Serial Monitor 115200 baud
2. Bluetooth Classic SPP name "HEATER_VER1_XXXXXX" (6-digit chip id)
3. WiFi -> built-in web dashboard http://<ip>/ or http://heater.local/
4. WiFi -> JSON API:
   GET /api/status?key=YOURKEY -> full JSON state
   GET /api/cmd?c=heat+high&key=YOURKEY -> run any command
   GET /api/wifiscan?key=YOURKEY -> nearby WiFi networks as JSON
       {"scan":[{"ssid":"Home","rssi":-55,"ch":6,"enc":3,"open":0}],"count":1}
   Join a router: /api/cmd?c=wifi+<ssid>+<pass>   (quote SSIDs with spaces:
       wifi "My Home" pass123). Status JSON reports "ssid" and "rssi".

API KEY / REMOTE ACCESS SECURITY
--------------------------------------------------------------------------
Set a key BEFORE port-forwarding to the internet:
  apikey mySecretPhrase123       set
  apikey                         check
  apikey clear                   clear (not recommended when exposed)
Once set, every /api/cmd and /api/status request needs &key=... or it is
rejected with HTTP 401. Serial and Bluetooth are not gated by the key.

AUTO-COMFORT MODE (bands + hysteresis hold)
--------------------------------------------------------------------------
room < target - 4C            -> HIGH (4 heaters)
target-4C <= room < target-2C -> MEDIUM (2 heaters)
target-2C <= room < target-HYS-> LOW (1 heater)
target-HYS <= room < target   -> HOLD current state (deadband)
room >= target                -> OFF (target reached)
HYS default 0.5C, range 0.1-2.0C ("sethys 0.3").
Target: "settemp 30" (range 10-60C). Re-checks once a minute.
Any manual heat command turns auto-comfort OFF.

ROOM TEMPERATURE (DS18B20, GPIO21)
--------------------------------------------------------------------------
"tempoffset 1.5" calibration offset (-10..10C, saved to flash).
A single reading jumping > 15C is discarded as a bus glitch.
No DS18B20 found -> one-time Serial warning (check 4.7k pull-up).

HEATER SELF-TEST ("test" command)
--------------------------------------------------------------------------
Fan comes ON first, then H1, H2, H3, H4 run 2000 ms each, one at a time,
then everything turns off. Cancelled by "fan off".

BUILD SETTINGS
--------------------------------------------------------------------------
Board : ESP32 Dev Module (ESP32-WROOM-32)
Partition Scheme : "No FS 4MB (2MB APP x2)"
                   (REQUIRED for wireless updates - OTA needs two app slots.
                    The sketch is ~1.94 MB, too big for "Minimal SPIFFS".)

WIRELESS FIRMWARE UPDATE (OTA)
--------------------------------------------------------------------------
Flow: app uploads .bin to the server -> server marks it "latest" -> board
checks every 6 h (and on "ota check") -> app sees "otaAvail" in the status
JSON and shows "Update available" -> user taps Update -> app sends
"ota install" -> board switches everything OFF, downloads into the spare
slot, verifies it (size + MD5), restarts on the new firmware. If anything
fails, the board keeps running the old firmware. Settings are kept.
  ota            show OTA state           ota check     ask the server now
  ota install    install the update       ota url <u>   install from a link
  Local (no server): POST the .bin to http://<board-ip>/api/ota?key=<apikey>
Server API expected (on cloudBaseUrl):
  GET /api/firmware/latest?model=HEATER_VER1&current=<fw>&device=<id>
      -> {"version":"1.6.0","url":"http://.../fw-1.6.0.bin",
          "size":1234567,"md5":"<32 hex>","notes":"what changed"}
      -> 204 (or "version" not newer) = no update
Libraries : IRremote (v4.x), OneWire, DallasTemperature, TM1637Display
==========================================================================
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <IRremote.hpp>
#include <TM1637Display.h>
#include "BluetoothSerial.h"
#include <Update.h>
#include "esp_ota_ops.h"

// ==========================================================================
// DEVICE IDENTITY
// --------------------------------------------------------------------------
// DEVICE_NAME : Bluetooth + hotspot prefix. The board broadcasts exactly
//               "HEATER_VER1_" + 6-digit chip id, e.g. HEATER_VER1_A1B2C3,
//               the same as the reference firmware the mobile app works with.
//               DO NOT CHANGE IT - the app lists only this exact format.
// FRIENDLY_NAME : your own label. Shown as the dashboard title and used as
//               the device name in the online web app. Change this freely.
// ==========================================================================
#define DEVICE_NAME   "HEATER_VER1"   // app lists ONLY "HEATER_VER1_xxxxxx" - change only after the app filter is changed
#define FRIENDLY_NAME "asvrl"

// ==========================================================================
// FEATURE SWITCHES
// ==========================================================================
#define USE_BT 1
#define USE_WIFI 1
#define USE_IR 1
#define USE_TEMP 1
#define USE_ENERGY_METER 1   // UART meter on GPIO16(RX)/17(TX); falls back to CT sum if absent
#define USE_DISPLAY 1
#define USE_CLOUD 1   // 1 = register + send telemetry to the online web app
// Own WiFi hotspot (HEATER_VER1_XXXXXX in the phone's WiFi list).
// 0 = OFF (recommended): setup is done over Bluetooth - the app asks the
//     board to scan nearby WiFi, you pick your router, the board joins it and
//     reports to the web app. Bluetooth is more stable with the hotspot off.
// 1 = ON : also broadcast the hotspot (phone can open http://192.168.4.1/).
#define USE_HOTSPOT 0

// >>> ONLINE WEB APP (admin portal) SERVER <<<
// Must be reachable from the heater's WiFi router. NOT "localhost".
#define CLOUD_SERVER_URL "http://50.186.180.197:4100"
#define CLOUD_ADMIN_KEY  "asvrlheaterfan"   // sent as X-Admin-Key header

#define BT_NAME DEVICE_NAME
#define AP_SSID DEVICE_NAME
#define AP_PASS "12345678" // min 8 chars
#define MDNS_NAME "heater" // http://heater.local/ (underscores are not valid in hostnames)

// ==========================================================================
// PIN MAP
// ==========================================================================
#define DEV_COUNT 6
enum DevIndex { DEV_H1 = 0, DEV_H2, DEV_H3, DEV_H4, DEV_FAN, DEV_LIGHT };

const uint8_t relayPin[DEV_COUNT] = { 25, 15, 2, 4, 18, 19 };
const uint8_t ctPin[DEV_COUNT] = { 36, 39, 34, 35, 32, 33 };
const char* devName[DEV_COUNT] = { "HEATER 1", "HEATER 2", "HEATER 3",
                                   "HEATER 4", "FAN", "LIGHT" };
const char* devKey[DEV_COUNT] = { "h1", "h2", "h3", "h4", "fan", "light" };

#define IND_LOW 13
#define IND_MED 12
#define IND_HIGH 14
#define IND_STATUS 27

#define BUZZER_PIN 26
#define IR_PIN 5

#define TEMP_PIN_1 21

#define TM_CLK_PIN 22
#define TM_DIO_PIN 23

// Relay board is driven through opto-couplers = ACTIVE HIGH
#define RELAY_ON HIGH
#define RELAY_OFF LOW
#define LED_ON HIGH
#define LED_OFF LOW

// ==========================================================================
// TUNING
// ==========================================================================
#define CT_SAMPLE_MS 100
#define CT_ROUND_MS 120
#define CT_NOISE_FLOOR 0.15f
#define NOLOAD_CHECK_MS 5000
#define NOLOAD_MIN_A 0.30f
#define PRINT_INTERVAL_MS 2000
#define TEMP_READ_MS 1500
#define CLIMATE_CHECK_MS 60000
#define TEST_STEP_MS 2000
#define TEMP_SANITY_JUMP 15.0f

// ==========================================================================
// STATE
// ==========================================================================
enum { LVL_OFF = 0, LVL_LOW = 1, LVL_MED = 2, LVL_HIGH = 3 };
const char* levelName[4] = { "OFF", "LOW", "MEDIUM", "HIGH" };

#define FLT_NONE 0
#define FLT_OVERCURRENT 1
#define FLT_NOLOAD 2
#define FLT_OVERTEMP 3

bool relayTarget[DEV_COUNT] = { false, false, false, false, false, false };
bool relayActual[DEV_COUNT] = { false, false, false, false, false, false };
uint8_t devFault[DEV_COUNT] = { 0, 0, 0, 0, 0, 0 };
float current[DEV_COUNT] = { 0, 0, 0, 0, 0, 0 };
double energyWh[DEV_COUNT] = { 0, 0, 0, 0, 0, 0 };
uint32_t onSince[DEV_COUNT] = { 0, 0, 0, 0, 0, 0 };
// Per-device power. current[] = what is shown/used (A). It comes from that
// device's CT when the CT reads, otherwise from the energy meter: each time a
// relay switches ON, the jump in meter watts is that device's real draw.
float    ctAmp[DEV_COUNT]   = { 0, 0, 0, 0, 0, 0 };   // raw CT reading (A)
float    learnW[DEV_COUNT]  = { 0, 0, 0, 0, 0, 0 };   // measured draw at switch-on (W)
bool     learned[DEV_COUNT] = { false, false, false, false, false, false };
char     pwrSrc[DEV_COUNT]  = { '-', '-', '-', '-', '-', '-' }; // C=CT M=meter ?=measuring -=off
int8_t   stepDev   = -1;      // device whose switch-on step is being measured
float    stepBefore = 0;      // meter watts just before it switched ON
uint32_t stepAt     = 0;      // millis() when it switched ON
#define  STEP_SETTLE_MS  1100 // meter frame must be this much newer than the switch
#define  STEP_TIMEOUT_MS 6000 // give up measuring after this
float    stepPrevP = -1;      // previous reading - a step is accepted only once 2 readings agree
#define  RUNNING_MIN_W   20.0f// a device adding less than this is "not running"
// ---- FAN INTERLOCK ----
// Heaters may switch ON only after the meter has CONFIRMED the fan draws
// current. Fan stops while heating -> everything OFF.  fanguard on|off, fanmin <W>
bool     fanGuard = true;     // saved
float    fanMinW  = 10.0f;    // fan must draw at least this (W) to count as running - saved
float devMinW(uint8_t d) { return d == 4 /*DEV_FAN*/ ? fanMinW : RUNNING_MIN_W; }
bool fanConfirmed();
void fanFail(const char* why);
// CT jack trust. An EMPTY jack floats and reads noise as fake amps, so a CT
// is used only when trusted:  ctuse <1-6> auto | on | off   (saved)
//   auto (default): ignored if it shows current while its relay is OFF
//                   (a real CT on an unpowered wire reads 0 -> noise = no CT)
//   on  : always used (CT fitted)      off : never used (jack empty)
uint8_t  ctMode[DEV_COUNT]  = { 0, 0, 0, 0, 0, 0 };   // 0 auto, 1 on, 2 off
bool     ctNoisy[DEV_COUNT] = { false, false, false, false, false, false };
bool ctUsable(uint8_t i) {
  if (ctMode[i] == 2) return false;
  if (ctMode[i] == 1) return true;
  return !ctNoisy[i];
}

uint8_t heatLevel = LVL_OFF;
bool manualMode = false;
bool autoFan = true;
bool systemTrip = false;
bool autoPrint = true;

// ---- AUTO-COMFORT MODE ---------------------------------------------------
// ON by default at every boot; target is saved to flash ("settemp <C>").
// Switch on/off with "climate on/off" (app, dashboard, IR slot 8, BT, Serial).
bool climateMode = false;          // OFF at boot - heating starts only from app / remote / command
float targetTemp = 24.0;           // loaded from flash at boot
float climateHysteresis = 0.5;
uint32_t tClimate = 0;
String climateWhy = "";            // why auto-comfort is / isn't heating (shown in app JSON)

// ---- HEATER SELF-TEST ----------------------------------------------------
bool testRunning = false;
uint8_t testStep = 0;
uint32_t testStepStart = 0;

float totalCurrent = 0;
float totalPower = 0;
float sumCurrent = 0;
const char* overallSrc = "CT SUM";
float tempC[1] = { -127 };
float maxTemp = -127;

float meterVoltage = 0, meterCurrent = 0, meterPower = 0, meterEnergy = 0, meterFreq = 0;
// Meter calibration (saved). Set from a clamp meter / multimeter reading:
//   meteri <amps you measured>    meterv <volts you measured>
float meterIScale = 1.0f, meterVScale = 1.0f;
float meterIRaw = 0, meterVRaw = 0;     // uncalibrated readings, used to compute the scales
float meterPrevP = 0;                   // previous frame watts (to see if readings are steady)

// saved settings
float calib[DEV_COUNT] = { 30.0, 30.0, 30.0, 30.0, 30.0, 30.0 };
float iLimit = 12.0;
float tLimit = 30.0;
float tempLimit = 85.0;
float mainsV = 230.0;
float tempOffset = 0.0;
String staSsid = "", staPass = "";
bool wifiApplyPending = false;   // new credentials saved, WiFi.begin() deferred
uint32_t wifiApplyAt = 0;        // millis() at which to run the deferred WiFi.begin()
uint32_t wifiAttemptAt = 0;      // millis() of the last router connect attempt
uint32_t wifiRetryMs = 15000;    // reconnect back-off: 15 s, 30 s, 60 s ... 5 min
String gDeviceId = "";           // unique id from the chip MAC, reported as "devid"
String gBtName = BT_NAME;        // BT_NAME + "_" + gDeviceId (set in setup)
String gFriendlyName = FRIENDLY_NAME; // FRIENDLY_NAME + "_" + gDeviceId (set in setup)
String gApSsid = AP_SSID;        // AP_SSID + "_" + gDeviceId (set in setup)
String gScanCache = "";          // last good WiFi scan JSON (sent when a live scan fails)
#define FW_VERSION "1.7.3"   // check this in the status header after flashing

#if USE_CLOUD
// ---- CLOUD TELEMETRY (online web app / admin portal) --------------------
bool     cloudEnabled    = true;               // report to server (default ON)
String   cloudBaseUrl    = CLOUD_SERVER_URL;   // compile-time
String   cloudProvKey    = "";                 // provisioning key, only if server needs one
String   cloudDeviceId   = "";                 // assigned by server at registration
String   cloudDeviceKey  = "";                 // secret returned at registration
String   cloudLastError  = "";
uint32_t cloudIntervalMs = 15000;              // updated from server's nextIntervalMs
uint32_t tCloud = 0;
uint32_t cloudHoldUntil = 0;                   // back-off after failed reports (0 = none)
#endif
uint32_t irCode[9] = { 0, 0, 0, 0, 0, 0, 0, 0, 0 };
int8_t irLearnSlot = -1;

String apiKey = "";
bool apiKeyWarned = false;
bool tempSensorWarned = false;

const char* irFnName[9] = { "POWER/ALL OFF", "LOW", "MEDIUM", "HIGH",
                            "FAN TOGGLE", "LIGHT TOGGLE", "LEVEL UP", "LEVEL DOWN",
                            "AUTO-COMFORT TOGGLE" };

Preferences prefs;
WebServer server(80);
#if USE_BT
BluetoothSerial SerialBT;
#endif

#if USE_TEMP
OneWire ow1(TEMP_PIN_1);
DallasTemperature ds1(&ow1);
#endif

#if USE_DISPLAY
TM1637Display tm1637(TM_CLK_PIN, TM_DIO_PIN);
#endif

uint32_t tCT = 0, tRelay = 0, tPrint = 0, tTemp = 0, tEnergy = 0, tLed = 0, tWiFi = 0, tDisplay = 0;
#define DISPLAY_UPDATE_MS 500
uint8_t ctIndex = 0;
bool tempRequested = false;

uint8_t beepLeft = 0; uint16_t beepOn = 0, beepOff = 0; uint32_t tBeep = 0; bool beepState = false;

String serialBuf = "", btBuf = "";

// ==========================================================================
// FORWARD DECLARATIONS
// ==========================================================================
String handleCommand(String cmd, const char* src);
String buildJson();
String jsonEscape(const String& in);
#if USE_ENERGY_METER
bool meterOnline();
#else
bool meterOnline() { return false; }
#endif
void stepStart(uint8_t i);
void measureAbort();
// ---- RECONNECT GUARD ----
// After a power cut the phone app reconnects and may RE-SEND its last button
// (e.g. "heat high") automatically. Any switch-ON command that arrives from the
// app within GUARD_MS of it (re)connecting is IGNORED, so only a real tap,
// made after that, can start anything. OFF commands are never blocked.
#define  GUARD_MS 20000          // ON commands ignored for 20 s after the app (re)connects
// APP_GUARD 0 = app commands work INSTANTLY (no waiting, no "tap twice").
// Power-cut safety is handled by safe start + mains-loss detection instead.
// Set to 1 only if the phone app is found re-sending its old state on reconnect.
#define  APP_GUARD 0
#define  POWERUP_LOCK_MS 60000   // app/web cannot switch anything ON for 60 s after power returns
bool     bootArmed = false;     // after a power-up the FIRST ON command from the app is ignored
// ---- MAINS POWER-CUT DETECTION ----
// When the ESP32 stays powered (USB / backup supply) a mains cut does NOT
// restart it, so the safe start never runs. The meter's voltage reading is
// used instead: mains below MAINS_LOST_V = power cut -> whole system OFF.
// When mains returns everything stays OFF and the app lock starts again.
#define  MAINS_LOST_V   90.0f
#define  MAINS_OK_V    150.0f
bool     mainsPresent = true;     // assume present until the meter says otherwise
uint32_t mainsBackAt  = 0;        // millis() when mains returned (0 = boot)
void     mainsLost(const char* why);
// ---- OTA (wireless firmware update) ----
#define  OTA_MODEL         "HEATER_VER1"
#define  OTA_CHECK_MS      (6UL * 3600UL * 1000UL)   // ask the server every 6 h
#define  OTA_FIRST_CHECK_MS 60000UL                  // first check 1 min after WiFi is up
String   otaState    = "idle";       // idle / checking / available / up-to-date / downloading / done / failed: ...
uint8_t  otaPct      = 0;
String   otaAvailVer = "", otaAvailUrl = "", otaAvailMd5 = "", otaAvailNotes = "";
uint32_t otaAvailSize = 0, otaLastCheck = 0;
bool     otaInstallReq = false;      // set by a command, done from loop()
bool     otaMarkedValid = false;
String   otaCommand(const String& lc, const String& cmd);
void     otaTick();
void     otaSetupWeb();
uint32_t btConnectedAt = 0, wifiConnectedAt = 0;
// ---- RE-MEASURE (find which device uses the meter's watts) ----
// Heaters OFF one by one (fan stays ON) -> fan watts = what is left on the
// meter -> heaters back ON one at a time, each switch-on step measured.
uint8_t  measPhase = 0;          // 0 = idle, 1 = heaters going OFF / reading fan
uint8_t  measSaved = 0;          // bitmask of heater targets to restore
uint32_t measStartAt = 0, measOffAt = 0, lastMeasureAt = 0, unexplainedSince = 0;
extern bool needRefine; extern uint32_t lastHeaterOnAt;
#define  UNEXPLAINED_W      30.0f    // meter watts not given to any device
#define  UNEXPLAINED_MS     10000    // ...for this long -> auto re-measure
#define  MEASURE_COOLDOWN_MS 600000  // at most one auto re-measure per 10 min
#if USE_WIFI
String buildWifiScanJson(bool suspendBt = false);
void startAsyncScan(uint8_t replyTo);
#endif
void printStatusTable();
void applyLevel(uint8_t lvl);
void saveSettings();
void fanOffKillsHeaters();
#if USE_CLOUD
void saveCloud();
void cloudTick();
#endif

// ==========================================================================
// BUZZER (non blocking)
// ==========================================================================
void beepMs(uint8_t times, uint16_t onMs, uint16_t offMs) {
  beepLeft = times; beepOn = onMs; beepOff = offMs;
  tBeep = 0; beepState = false;
}

void beep(uint8_t times) { beepMs(times, 60, 80); }

void buzzerTick() {
  if (beepLeft == 0) { digitalWrite(BUZZER_PIN, LOW); return; }
  uint32_t now = millis();
  if (!beepState && (now - tBeep >= beepOff)) {
    digitalWrite(BUZZER_PIN, HIGH); beepState = true; tBeep = now;
  } else if (beepState && (now - tBeep >= beepOn)) {
    digitalWrite(BUZZER_PIN, LOW); beepState = false; tBeep = now;
    if (--beepLeft == 0) return;
  }
}

// ==========================================================================
// RELAY CONTROL - HOW THE HEATER SWITCHES
// --------------------------------------------------------------------------
// Commands (app, Bluetooth, web, IR, auto-comfort) only change the TARGET
// state. relayTick() then moves the real relays to the target in one fixed,
// safe order, so every control path behaves exactly the same:
//
//   Heat ON  : fan ON -> fan runs FAN_LEAD_MS -> heaters ON one at a time,
//              HEATER_STAGGER_MS apart (limits inrush current)
//   Heat OFF : heaters OFF one at a time (fast) -> fan keeps running for
//              FAN_RUNON_MS to cool the elements -> fan OFF
//   Fan OFF  : heaters OFF -> fan OFF straight after (no run-on)
//   LIGHT    : switches immediately, never waits behind the heaters
//
// Hard rules: a heater relay is never switched ON unless the fan relay is
// ON and has run FAN_LEAD_MS, and the fan relay is never switched OFF while
// any heater relay is still ON.
// ==========================================================================
#define FAN_LEAD_MS        2000   // fan runs this long before the first heater
#define HEATER_STAGGER_MS  2000   // gap between heater relays switching ON
#define HEATER_OFF_GAP_MS   150   // gap between heater relays switching OFF
#define FAN_RUNON_MS      30000   // fan run-on after heat OFF (0 = no run-on)

bool     fanUser        = false;  // fan asked for by the user (fan on / IR / autofan off)
bool     skipRunOn      = false;  // next heater stop skips the run-on (fan off / all off)
bool     overTempActive = false;  // over-temperature condition present right now
bool     climateCheckNow = true;  // run the next auto-comfort check immediately
uint32_t fanOnAt        = 0;      // millis() when the fan relay switched ON
uint32_t heatersOffAt   = 0;      // millis() when the last heater relay switched OFF
uint32_t nextRelayAt    = 0;      // earliest millis() for the next fan/heater change

bool anyHeaterTarget() { for (uint8_t i = 0; i < 4; i++) if (relayTarget[i]) return true; return false; }
bool anyHeaterActual() { for (uint8_t i = 0; i < 4; i++) if (relayActual[i]) return true; return false; }
bool fanFaulted()      { return devFault[DEV_FAN] == FLT_OVERCURRENT; }

// A heater may be switched ON only if nothing blocks it.
bool heaterAvailable(uint8_t i) {
  if (i >= 4 || systemTrip || fanFaulted() || overTempActive) return false;
  return devFault[i] != FLT_OVERCURRENT && devFault[i] != FLT_OVERTEMP;
}

void setDev(uint8_t i, bool on) {
  if (i >= DEV_COUNT) return;
  if (on) {
    if (systemTrip) return;
    if (devFault[i] == FLT_OVERCURRENT || devFault[i] == FLT_OVERTEMP) return;
    if (i < 4) {
      if (!heaterAvailable(i)) return;
      skipRunOn = false;
    }
  }
  relayTarget[i] = on;
}

// Remaining fan run-on time in ms (0 = none).
uint32_t fanRunOnLeft() {
  if (FAN_RUNON_MS == 0 || heatersOffAt == 0 || skipRunOn || anyHeaterActual()) return 0;
  uint32_t el = millis() - heatersOffAt;
  return el < FAN_RUNON_MS ? FAN_RUNON_MS - el : 0;
}

// The fan target is worked out here, every loop, from the heater state -
// no other code needs to remember to switch the fan.
void updateFanTarget() {
  bool want = anyHeaterTarget() || anyHeaterActual() || fanUser || testRunning ||
              overTempActive || fanRunOnLeft() > 0;
  if (systemTrip) want = anyHeaterActual();   // locked out: stop once heaters are off
  if (fanFaulted()) want = false;
  relayTarget[DEV_FAN] = want;
}

// ---- FAN OFF REQUEST: no fan = no heater ---------------------------------
void fanOffKillsHeaters() {
  for (uint8_t i = 0; i < 4; i++) relayTarget[i] = false;
  heatLevel = LVL_OFF;
  manualMode = false;
  climateMode = false;
  testRunning = false; testStep = 0; testStepStart = 0;
  fanUser = false;
  skipRunOn = true;
  Serial.println("[FAN  ] fan OFF requested - heaters OFF first, then fan");
}

// ---- FAN ON REQUEST ---------------------------------------------------------
bool fanOnRequest() {
  if (fanFaulted() || systemTrip) return false;
  fanUser = true;
  return true;
}

static void switchRelay(uint8_t i) {
  relayActual[i] = relayTarget[i];
  digitalWrite(relayPin[i], relayActual[i] ? RELAY_ON : RELAY_OFF);
  onSince[i] = relayActual[i] ? millis() : 0;
  if (!relayActual[i] && devFault[i] == FLT_NOLOAD) devFault[i] = FLT_NONE;
  if (i == DEV_FAN) fanOnAt = relayActual[i] ? millis() : 0;
  Serial.printf("[RELAY] %-9s -> %s\n", devName[i], relayActual[i] ? "ON" : "OFF");
  if (measPhase) return;                       // drop test switches heaters itself - keep its values
  if (relayActual[i]) {
    stepStart(i);
    if (i < 4) { lastHeaterOnAt = millis(); needRefine = true; }
  }
  else { learned[i] = false; learnW[i] = 0; if (stepDev == (int8_t)i) stepDev = -1; }
}

// Start measuring the meter step for device i (it just switched ON).
void stepStart(uint8_t i) {
  learned[i] = false; learnW[i] = 0;
  // Heaters are NOT measured at switch-on: their draw falls as they warm up,
  // so the 2nd/3rd/4th heater's jump came out too small (showed 0 A / red /
  // NO LOAD while really running). Heaters share the meter watts instead and
  // the drop test (60 s after heating starts) measures each one properly.
  if (i < 4) return;
  if (!meterOnline() || stepDev >= 0) return;   // no meter, or another step in progress
  stepDev = i; stepBefore = meterPower; stepAt = millis(); stepPrevP = -1;
}

// true while a switch-on step is still being measured (holds the next relay ON)
bool stepBusy() {
  if (stepDev < 0) return false;
  if (millis() - stepAt > STEP_TIMEOUT_MS) {
    Serial.printf("[POWER] %s: no meter reading in time - not measured\n", devName[stepDev]);
    stepDev = -1; return false;
  }
  return true;
}

void relayTick() {
  uint32_t now = millis();

  // LIGHT: independent and immediate
  if (relayTarget[DEV_LIGHT] != relayActual[DEV_LIGHT]) switchRelay(DEV_LIGHT);

  updateFanTarget();
  if ((int32_t)(now - nextRelayAt) < 0) return;

  // 1) heaters OFF first
  for (uint8_t i = 0; i < 4; i++) {
    if (!relayTarget[i] && relayActual[i]) {
      switchRelay(i);
      nextRelayAt = now + HEATER_OFF_GAP_MS;
      if (!anyHeaterActual()) {
        heatersOffAt = now;
        if (!autoFan && !skipRunOn) fanUser = true;   // autofan off: fan stays on
        if (relayActual[DEV_FAN] && FAN_RUNON_MS && !skipRunOn && !fanUser)
          Serial.printf("[FAN  ] run-on %u s to cool the elements\n", (unsigned)(FAN_RUNON_MS / 1000));
      }
      return;
    }
  }

  // Wait for the meter to measure the last device that switched ON, so each
  // device's own watts are known. (Never delays any switch-OFF above.)
  if (stepBusy()) return;

  // 2) fan ON
  if (relayTarget[DEV_FAN] && !relayActual[DEV_FAN]) {
    switchRelay(DEV_FAN);
    nextRelayAt = now + HEATER_STAGGER_MS;
    return;
  }

  // 3) heaters ON - only once the fan has been running FAN_LEAD_MS
  if (relayActual[DEV_FAN] && now - fanOnAt >= FAN_LEAD_MS && fanConfirmed()) {
    for (uint8_t i = 0; i < 4; i++) {
      if (relayTarget[i] && !relayActual[i]) {
        switchRelay(i);
        nextRelayAt = now + HEATER_STAGGER_MS;
        return;
      }
    }
  }

  // 4) fan OFF - only when every heater relay is physically off
  if (!relayTarget[DEV_FAN] && relayActual[DEV_FAN] && !anyHeaterActual()) {
    switchRelay(DEV_FAN);
    nextRelayAt = now + HEATER_OFF_GAP_MS;
  }
}

void indicationTick() {
  bool anyFault = systemTrip;
  for (uint8_t i = 0; i < DEV_COUNT; i++) if (devFault[i]) anyFault = true;

  digitalWrite(IND_LOW, (heatLevel == LVL_LOW) ? LED_ON : LED_OFF);
  digitalWrite(IND_MED, (heatLevel == LVL_MED) ? LED_ON : LED_OFF);
  digitalWrite(IND_HIGH, (heatLevel == LVL_HIGH) ? LED_ON : LED_OFF);

  static bool blink = false;
  if (anyFault) {
    if (millis() - tLed > 200) { tLed = millis();
      blink = !blink;
      digitalWrite(IND_STATUS, blink ? LED_ON : LED_OFF); }
  } else {
    bool linked = (WiFi.status() == WL_CONNECTED);
#if USE_BT
    linked = linked || SerialBT.hasClient();
#endif
    digitalWrite(IND_STATUS, linked ? LED_ON : LED_OFF);
  }
}

// ==========================================================================
// HEAT LEVEL
// heatLevel always reflects the heater TARGETS, so the lamps, display, app
// and web app never show a level that isn't really requested.
// ==========================================================================
void recalcLevelFromRelays() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < 4; i++) if (relayTarget[i]) n++;
  if (n == 0) heatLevel = LVL_OFF;
  else if (n == 1) heatLevel = LVL_LOW;
  else if (n == 2) heatLevel = LVL_MED;
  else heatLevel = LVL_HIGH;
}

void applyLevel(uint8_t lvl) {
  if (systemTrip && lvl != LVL_OFF) {
    Serial.println("[SAFE ] SYSTEM TRIPPED - send 'reset' first");
    beep(3);
    return;
  }
  if (lvl > LVL_HIGH) lvl = LVL_HIGH;
  uint8_t before = heatLevel;

  uint8_t n = 0;
  if (lvl == LVL_LOW) n = 1;
  if (lvl == LVL_MED) n = 2;
  if (lvl == LVL_HIGH) n = 4;

  // Use the first n healthy heaters, so one faulty element doesn't stop LOW/MEDIUM.
  uint8_t placed = 0;
  for (uint8_t i = 0; i < 4; i++) {
    bool want = (placed < n) && heaterAvailable(i);
    if (want) placed++;
    setDev(i, want);
  }
  manualMode = false;
  recalcLevelFromRelays();

  if (placed < n)
    Serial.printf("[MODE ] %s asked, only %u of %u heater(s) available (fault / fan / over-temp)\n",
                  levelName[lvl], placed, n);
  Serial.printf("[MODE ] %s -> %u heater(s)\n", levelName[heatLevel], placed);
  if (heatLevel != before) beep(heatLevel == LVL_OFF ? 1 : heatLevel);
}

// ==========================================================================
// AUTO-COMFORT MODE (target-temperature bands + hysteresis hold)
// OFF at every boot (safe start); toggle with climate on/off. Checks immediately when
// switched on or when the target changes, then once every CLIMATE_CHECK_MS
// (so the relays don't chatter). If the temperature sensor is lost while
// heating, heat goes OFF for safety.
// ==========================================================================
void climateTick() {
  if (!climateMode) return;
  if (measPhase) return;          // don't fight a re-measure in progress
  if (!climateCheckNow && millis() - tClimate < CLIMATE_CHECK_MS) return;
  climateCheckNow = false;
  tClimate = millis();
  if (systemTrip) return;

  float room = maxTemp;
  bool roomValid = (room > -50 && room < 200);
  if (!roomValid) {
    climateWhy = "NO TEMPERATURE SENSOR - heaters stay OFF (check DS18B20 on GPIO21 + 4.7k pull-up)";
    if (heatLevel != LVL_OFF) {
      Serial.println("[CLIM ] temperature sensor lost - heat OFF for safety");
      applyLevel(LVL_OFF);
    } else {
      Serial.println("[CLIM ] no valid temperature yet - retry in 5 s");
    }
    tClimate = millis() - CLIMATE_CHECK_MS + 5000;   // retry soon
    return;
  }

  float diff = targetTemp - room;
  uint8_t want;
  if (diff >= 4.0) want = LVL_HIGH;
  else if (diff >= 2.0) want = LVL_MED;
  else if (diff >= climateHysteresis) want = LVL_LOW;
  else if (diff > 0) want = (heatLevel > LVL_LOW) ? (uint8_t)LVL_LOW : heatLevel;   // deadband: never more than LOW
  else want = LVL_OFF;
  climateWhy = "room " + String(room, 1) + " C, target " + String(targetTemp, 1) + " C -> " + levelName[want] +
               (want == LVL_OFF ? " (room already at/above target)" : "");

  if (want != heatLevel) {
    Serial.printf("[CLIM ] room %.1fC (target %.1fC, hys %.1fC) -> %s\n",
                  room, targetTemp, climateHysteresis, levelName[want]);
    applyLevel(want);
  }
}

// ==========================================================================
// HEATER SELF-TEST ("test" command)
// Fan ON first (FAN_LEAD_MS), then each heater runs TEST_STEP_MS alone.
// ==========================================================================
void applyTestRelay(uint8_t idx) {
  for (uint8_t i = 0; i < 4; i++) {
    bool want = (i == idx) && heaterAvailable(i);
    if (relayTarget[i] != want || relayActual[i] != want) {
      relayTarget[i] = want;
      relayActual[i] = want;
      digitalWrite(relayPin[i], want ? RELAY_ON : RELAY_OFF);
      onSince[i] = want ? millis() : 0;
      if (!want && devFault[i] == FLT_NOLOAD) devFault[i] = FLT_NONE;
      Serial.printf("[RELAY] %-9s -> %s (test)\n", devName[i], want ? "ON" : "OFF");
      if (want) stepStart(i);
      else { learned[i] = false; learnW[i] = 0; if (stepDev == (int8_t)i) stepDev = -1; }
    }
  }
}

void startSelfTest() {
  if (systemTrip) { Serial.println("[TEST ] Can't start - system TRIPPED, send 'reset' first"); return; }
  climateMode = false;
  for (uint8_t i = 0; i < 4; i++) relayTarget[i] = false;
  manualMode = true;
  testRunning = true;
  testStep = 0;
  testStepStart = 0;
  skipRunOn = false;
  Serial.printf("[TEST ] Heater self-test: fan first, then H1..H4, %u ms each\n", (unsigned)TEST_STEP_MS);
  beep(1);
}

void testTick() {
  if (!testRunning) return;
  uint32_t now = millis();

  if (fanFaulted()) {
    Serial.println("[TEST ] fan fault - self-test aborted");
    for (uint8_t i = 0; i < 4; i++) relayTarget[i] = false;
    recalcLevelFromRelays(); manualMode = false;
    testRunning = false; testStep = 0;
    return;
  }

  if (testStep < 4) {
    if (testStepStart == 0) {
      // fan must be ON and running FAN_LEAD_MS (relayTick switches it via testRunning)
      if (!relayActual[DEV_FAN] || now - fanOnAt < FAN_LEAD_MS) return;
      applyTestRelay(testStep);
      recalcLevelFromRelays();
      testStepStart = now;
      Serial.printf("[TEST ] %s ON for %u ms\n", devName[testStep], (unsigned)TEST_STEP_MS);
    } else if (now - testStepStart >= TEST_STEP_MS) {
      testStep++;
      testStepStart = 0;
    }
  } else {
    for (uint8_t i = 0; i < 4; i++) setDev(i, false);   // relayTick turns them off, fan runs on
    recalcLevelFromRelays();
    manualMode = false;
    testRunning = false;
    Serial.println("[TEST ] self-test complete - all heaters OFF");
    beep(2);
  }
}

void allOff(const char* why) {
  for (uint8_t i = 0; i < DEV_COUNT; i++) relayTarget[i] = false;
  heatLevel = LVL_OFF; manualMode = false;
  climateMode = false;
  testRunning = false; testStep = 0; testStepStart = 0;
  fanUser = false;
  skipRunOn = true;
  Serial.printf("[SAFE ] ALL OUTPUTS OFF (%s)\n", why);
}

// ==========================================================================
// CT CURRENT MEASUREMENT (SCT-013-000, RMS by variance method)
// ==========================================================================
float readCT(uint8_t ch) {
  uint32_t start = millis();
  double sum = 0, sumSq = 0; uint32_t n = 0;

  while (millis() - start < CT_SAMPLE_MS) {
    int adc = analogRead(ctPin[ch]);
    sum += adc;
    sumSq += (double)adc * adc;
    n++;
  }
  if (n == 0) return 0;

  double mean = sum / n;
  double var = (sumSq / n) - (mean * mean);
  if (var < 0) var = 0;

  double rmsADC = sqrt(var);
  float rmsV = (rmsADC / 4095.0) * 3.3;
  float amps = rmsV * calib[ch];

  if (amps < CT_NOISE_FLOOR) amps = 0;
  return amps;
}

void ctTick() {
  if (millis() - tCT < CT_ROUND_MS) return;
  tCT = millis();

  ctAmp[ctIndex] = readCT(ctIndex);
  if (ctMode[ctIndex] == 0 && !ctNoisy[ctIndex] && !relayActual[ctIndex] &&
      millis() - onSince[ctIndex] > 1000 && ctAmp[ctIndex] > 0) {
    ctNoisy[ctIndex] = true;
    Serial.printf("[CT   ] CT%u reads %.2f A with its relay OFF - jack empty/noisy, IGNORED (ctuse %u on to force)\n",
                  ctIndex + 1, ctAmp[ctIndex], ctIndex + 1);
  }

  ctIndex++;
  if (ctIndex >= DEV_COUNT) {
    ctIndex = 0;
    sumCurrent = 0;
    for (uint8_t i = 0; i < DEV_COUNT; i++) if (ctUsable(i) && relayActual[i]) sumCurrent += ctAmp[i];

#if USE_ENERGY_METER
    if (meterCurrent > 0.05 || meterPower > 5.0) {
      totalCurrent = meterCurrent;
      totalPower = meterPower;
      overallSrc = "METER";
    } else {
      totalCurrent = sumCurrent;
      totalPower = sumCurrent * mainsV;
      overallSrc = "CT SUM";
    }
#else
    totalCurrent = sumCurrent;
    totalPower = sumCurrent * mainsV;
    overallSrc = "CT SUM";
#endif
  }
}

void energyTick() {
  uint32_t now = millis();
  if (now - tEnergy < 1000) return;
  float dtH = (now - tEnergy) / 3600000.0;
  tEnergy = now;
  for (uint8_t i = 0; i < DEV_COUNT; i++)
    energyWh[i] += current[i] * mainsV * dtH;
}

// ==========================================================================
// TEMPERATURE (async) - single DS18B20 probe
// ==========================================================================
#if USE_TEMP
void tempTick() {
  if (!tempRequested) {
    if (millis() - tTemp < TEMP_READ_MS) return;
    ds1.requestTemperatures();
    tempRequested = true; tTemp = millis();
    return;
  }
  if (millis() - tTemp < 800) return;

  if (ds1.getDeviceCount() == 0) {
    if (!tempSensorWarned) {
      Serial.println("[TEMP ] WARNING: no DS18B20 detected on GPIO21 - check wiring / 4.7k pull-up resistor between DQ and 3.3V");
      tempSensorWarned = true;
    }
    tempC[0] = -127;
  } else {
    tempSensorWarned = false;
    float raw = ds1.getTempCByIndex(0);
    if (raw > -50 && raw < 200) {
      raw += tempOffset;
      if (maxTemp < -50 || fabs(raw - maxTemp) <= TEMP_SANITY_JUMP) {
        tempC[0] = raw;
      } else {
        Serial.printf("[TEMP ] discarded implausible reading %.1fC (last good %.1fC) - probable bus glitch\n", raw, maxTemp);
      }
    } else {
      tempC[0] = -127;
    }
  }

  maxTemp = -127;
  if (tempC[0] > -50 && tempC[0] < 200) maxTemp = tempC[0];

  tempRequested = false; tTemp = millis();
}
#endif

// ==========================================================================
// DISPLAY (TM1637 4-digit 7-segment, CLK=GPIO22 DIO=GPIO23)
// ==========================================================================
#if USE_DISPLAY
void displayTick() {
  if (millis() - tDisplay < DISPLAY_UPDATE_MS) return;
  tDisplay = millis();

  float room = maxTemp;
  bool roomValid = (room > -50 && room < 200);

  if (!roomValid) {
    const uint8_t dashes[] = { SEG_G, SEG_G, SEG_G, SEG_G };
    tm1637.setSegments(dashes);
    return;
  }

  long scaledCheck = (long)round(room * 100.0);
  long hundredthsRemainder = labs(scaledCheck) % 10;
  int decimalDigits = (hundredthsRemainder != 0) ? 2 : 1;

  long scale = (decimalDigits == 2) ? 100 : 10;
  long scaledVal = (long)round(room * scale);
  bool negative = scaledVal < 0;
  unsigned long mag = negative ? (unsigned long)(-scaledVal) : (unsigned long)scaledVal;

  uint8_t rawDigits[4] = { 0, 0, 0, 0 };
  int nDigits = 0;
  unsigned long v = mag;
  do {
    if (nDigits < 4) rawDigits[nDigits] = v % 10;
    nDigits++;
    v /= 10;
  } while (v > 0 && nDigits < 4);
  if (nDigits > 4) nDigits = 4;

  uint8_t segs[4] = { 0, 0, 0, 0 };
  for (int i = 0; i < nDigits; i++) {
    int pos = 3 - i;
    segs[pos] = tm1637.encodeDigit(rawDigits[i]);
  }
  int dotPos = 3 - decimalDigits;
  if (dotPos >= 0) segs[dotPos] |= 0x80;
  if (negative) {
    int signPos = 3 - nDigits;
    if (signPos >= 0) segs[signPos] = SEG_G;
  }

  tm1637.setSegments(segs, 4, 0);
}
#endif

// ==========================================================================
// SAFETY
// ==========================================================================
void safetyTick() {
  // FAN IS MASTER: no working fan = no heater
  if (fanFaulted() && anyHeaterTarget()) {
    for (uint8_t i = 0; i < 4; i++) relayTarget[i] = false;
    recalcLevelFromRelays();
    climateMode = false;
    Serial.println("[FAULT] FAN fault - all heaters OFF");
  }

  // per channel over current
  bool anyOverCurrentTrip = false;
  for (uint8_t i = 0; i < DEV_COUNT; i++) {
    if (relayActual[i] && current[i] > iLimit && devFault[i] != FLT_OVERCURRENT) {
      devFault[i] = FLT_OVERCURRENT;
      relayTarget[i] = false;
      anyOverCurrentTrip = true;
      Serial.printf("[FAULT] %s OVER CURRENT %.2f A (limit %.1f A) - tripped\n",
                    devName[i], current[i], iLimit);
      beepMs(4, 120, 80);
      recalcLevelFromRelays();
    }
  }
  (void)anyOverCurrentTrip;

  // total over current -> full lockout
  if (totalCurrent > tLimit && !systemTrip) {
    systemTrip = true;
    allOff("TOTAL OVER CURRENT");
    Serial.printf("[FAULT] TOTAL %.2f A > %.1f A -> SYSTEM LOCKED. send 'reset'\n",
                  totalCurrent, tLimit);
    beepMs(6, 150, 100);
  }

  // no-load detection
  for (uint8_t i = 0; i < DEV_COUNT; i++) {
    if (i == DEV_LIGHT) continue;
    // current flowing again -> NO LOAD warning clears by itself
    if (devFault[i] == FLT_NOLOAD && current[i] >= NOLOAD_MIN_A) {
      devFault[i] = FLT_NONE;
      Serial.printf("[INFO ] %s current OK again - NO LOAD cleared\n", devName[i]);
      continue;
    }
    // don't judge a device whose watts are still being measured
    bool measuring = (stepDev == (int8_t)i) || measPhase || pwrSrc[i] == '?';
    if (relayActual[i] && onSince[i] && !measuring &&
        (millis() - onSince[i] > NOLOAD_CHECK_MS) &&
        current[i] < NOLOAD_MIN_A && devFault[i] == FLT_NONE) {
      if (i == DEV_FAN && fanGuard && meterOnline() && anyHeaterActual()) {
        fanFail("fan stopped drawing current while heating");
        continue;
      }
      devFault[i] = FLT_NOLOAD;
      Serial.printf("[FAULT] %s NO LOAD - element/fuse check\n", devName[i]);
      beepMs(2, 200, 150);
    }
  }

#if USE_TEMP
  // over temperature -> heaters off, fan forced on (updateFanTarget) until cool
  if (maxTemp > -50) {
    if (!overTempActive && maxTemp >= tempLimit) {
      overTempActive = true;
      for (uint8_t i = 0; i < 4; i++) { relayTarget[i] = false; devFault[i] = FLT_OVERTEMP; }
      recalcLevelFromRelays();
      Serial.printf("[FAULT] OVER TEMP %.1f C >= %.1f C - heaters OFF, fan ON\n",
                    maxTemp, tempLimit);
      beepMs(5, 150, 100);
    }
    if (overTempActive && maxTemp < (tempLimit - 10.0)) {
      overTempActive = false;
      for (uint8_t i = 0; i < 4; i++) if (devFault[i] == FLT_OVERTEMP) devFault[i] = FLT_NONE;
      Serial.println("[INFO ] Temperature normal - heaters can be turned ON again");
      beep(1);
    }
  }
#endif
}

// ==========================================================================
// ENERGY METER (optional UART meter on GPIO16/17)
// ==========================================================================
#if USE_ENERGY_METER
// Same scaling as the standalone "Energy Meter" test sketch (0x58 0xAA query).
// Frame bytes (little-endian, 24-bit):
//   [1..3] current  [4..6] voltage  [10..12] power  [13..15] energy  [16..18] frequency
const double Cur_mR = 10200.0, Volt_mR = 28700.0;
#define METER_POLL_MS   1000      // one query per second
#define METER_REPLY_MS   500      // give up on a reply after this
#define METER_STALE_MS  5000      // no good frame this long -> meter treated as absent
uint8_t  meterState = 0;
uint32_t meterTime = 0;
uint32_t meterLastOk = 0;         // millis() of the last valid frame (0 = never)
uint8_t  meterFrame[32];
uint8_t  meterLen = 0;

static inline uint32_t meterU24(uint8_t i) {
  return (uint32_t)meterFrame[i] | ((uint32_t)meterFrame[i + 1] << 8) | ((uint32_t)meterFrame[i + 2] << 16);
}

bool meterOnline() { return meterLastOk && (millis() - meterLastOk < METER_STALE_MS); }

void mainsLost(const char* why) {
  mainsPresent = false;
  bool anyOn = false;
  for (uint8_t i = 0; i < DEV_COUNT; i++) if (relayTarget[i] || relayActual[i]) anyOn = true;
  measPhase = 0; measSaved = 0;
  allOff("POWER CUT");
  for (uint8_t i = 0; i < DEV_COUNT; i++) { relayActual[i] = false; digitalWrite(relayPin[i], RELAY_OFF); onSince[i] = 0; }
  climateMode = false; bootArmed = false;
  Serial.printf("[MAINS] POWER CUT detected (%s) - whole system OFF%s\n", why,
                anyOn ? ", it will NOT restart by itself" : "");
}

void meterDecode() {
  double i  = (double)meterU24(1)  * 1218.0 * 1000.0 / 305978.0 / Cur_mR / 1000.0;   // A
  double v  = (double)meterU24(4)  * 1218.0 * 22.0 * 5.0 / 73978.0 / Volt_mR;        // V
  // Power register is SIGNED 24-bit: tiny negative noise at no load (0xFFFFFE) must
  // not read as ~2644 W. Sign-extend, take the magnitude (works even if the CT/shunt
  // direction is reversed) and drop sub-2 W noise.
  int32_t pRaw = (int32_t)(meterU24(10) << 8) >> 8;
  double p  = fabs((double)pRaw) * 1218.0 * 1218.0 * 22.0 * 5.0 / 3537.0 / Cur_mR / Volt_mR;  // W
  if (p < 2.0) p = 0;
  double e  = (double)meterU24(13) * 16384.0 * 256.0 * 1218.0 * 1218.0 * 22.0 * 5.0
              / 36000.0 / 3537.0 / Cur_mR / Volt_mR;                                  // Wh
  uint32_t fr = meterU24(16);
  double f  = fr ? 2.0 * 500000.0 / (double)fr : 0;                                   // Hz (guard /0)

  // apply calibration (power and energy scale with both)
  meterIRaw = i; meterVRaw = v;
  i *= meterIScale; v *= meterVScale;
  p *= meterIScale * meterVScale; e *= meterIScale * meterVScale;

  // Reject only physically impossible values (misaligned / garbage frame).
  // 0 V is allowed: a meter on the bench with no mains on its input reads ~0.
  if (v > 300 || i > 100 || p > 25000) {
    static uint32_t tBadLog = 0;
    if (millis() - tBadLog > 10000) {          // log at most every 10 s
      tBadLog = millis();
      Serial.printf("[METER] bad frame ignored (V=%.1f I=%.2f P=%.1f, %u bytes):", v, i, p, meterLen);
      for (uint8_t k = 0; k < meterLen; k++) Serial.printf(" %02X", meterFrame[k]);
      Serial.println();
    }
    return;
  }
  meterPrevP = meterPower;
  meterCurrent = i; meterVoltage = v; meterPower = p;
  meterEnergy  = e;
  meterFreq    = (f > 40 && f < 70) ? f : 0;
  if (v > 90 && v < 300) mainsV = v;     // only trust a real mains reading for CT power math
  if (mainsPresent && v < MAINS_LOST_V) {
    mainsLost("mains voltage gone");
  } else if (!mainsPresent && v > MAINS_OK_V) {
    mainsPresent = true; mainsBackAt = millis(); bootArmed = false;
    Serial.printf("[MAINS] power back (%.0f V) - everything stays OFF until you turn it on\n", v);
  }
  meterLastOk  = millis();

  // Finish the switch-on measurement: watts added by that one device.
  if (stepDev >= 0 && meterLastOk - stepAt >= STEP_SETTLE_MS) {
    // Wait until the meter has SETTLED: two readings in a row within 3 % (+5 W).
    bool settled = stepPrevP >= 0 && fabs(meterPower - stepPrevP) <= meterPower * 0.03f + 5.0f;
    bool lastChance = meterLastOk - stepAt > STEP_TIMEOUT_MS - 1500;
    if (!settled && !lastChance) { stepPrevP = meterPower; return; }
    stepPrevP = -1;
    uint8_t d = stepDev; stepDev = -1;
    if (relayActual[d]) {
      float dw = meterPower - stepBefore;
      learnW[d] = dw > devMinW(d) ? dw : 0;
      learned[d] = true;
      if (learnW[d] > 0)
        Serial.printf("[POWER] %s draws %.0f W (meter %.0f -> %.0f W)\n", devName[d], dw, stepBefore, meterPower);
      else
        Serial.printf("[POWER] %s relay ON but draws no power - NOT RUNNING\n", devName[d]);
    }
  }
}

void meterTick() {
  switch (meterState) {
    case 0:   // idle - wait for next poll
      if (millis() - meterTime >= METER_POLL_MS) {
        while (Serial2.available()) Serial2.read();   // flush stray bytes first
        uint8_t cmd[2] = { 0x58, 0xAA };
        Serial2.write(cmd, 2);
        meterLen = 0;
        meterState = 1; meterTime = millis();
      }
      break;

    case 1:   // collecting the reply - drain everything that has arrived
      while (Serial2.available()) {
        uint8_t b = Serial2.read();
        if (meterLen < sizeof(meterFrame)) meterFrame[meterLen++] = b;
        meterTime = millis();
      }
      if (meterLen >= 19 && millis() - meterTime > 4) {   // frame complete (gap after last byte)
        meterDecode();
        meterState = 0; meterTime = millis();
      } else if (millis() - meterTime > METER_REPLY_MS) { // no / short reply
        meterState = 0; meterTime = millis();
      }
      break;
  }

  // Meter unplugged or silent: zero its values so ctTick() falls back to the CT sum
  // (otherwise the last reading would stick and drive the total-current trip forever).
  if (meterLastOk && !meterOnline()) {
    meterLastOk = 0;
    meterCurrent = meterPower = meterVoltage = meterFreq = 0;
    if (mainsPresent) mainsLost("meter stopped replying");
    Serial.println("[METER] no reply for 5 s - using CT sum");
  }
}
#endif

// ==========================================================================
// IR REMOTE
// ==========================================================================
#if USE_IR
void runIrFunction(uint8_t fn) {
  measureAbort();                 // a key press always wins over a re-measure
  switch (fn) {
    case 0: allOff("IR POWER"); beep(1); break;   // does NOT clear a trip - use 'reset'
    case 1: climateMode = false; applyLevel(LVL_LOW); break;
    case 2: climateMode = false; applyLevel(LVL_MED); break;
    case 3: climateMode = false; applyLevel(LVL_HIGH); break;
    case 4:
      if (relayTarget[DEV_FAN]) fanOffKillsHeaters();
      else if (!fanOnRequest()) { beep(3); break; }
      beep(1); break;
    case 5: setDev(DEV_LIGHT, !relayTarget[DEV_LIGHT]); beep(1); break;
    case 6: climateMode = false; applyLevel(heatLevel < LVL_HIGH ? heatLevel + 1 : LVL_HIGH); break;
    case 7: climateMode = false; applyLevel(heatLevel > LVL_OFF ? heatLevel - 1 : LVL_OFF); break;
    case 8:
      if (climateMode) { climateMode = false; Serial.println("[CLIM ] auto-comfort OFF (IR)"); beep(1); }
      else if (!systemTrip) { climateMode = true; climateCheckNow = true; Serial.println("[CLIM ] auto-comfort ON (IR)"); beep(2); }
      else beep(3);
      break;
  }
}

void irTick() {
  if (!IrReceiver.decode()) return;
  uint32_t code = IrReceiver.decodedIRData.decodedRawData;
  bool repeat = (IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT);

  if (code != 0 && !repeat) {
    Serial.printf("[IR ] code 0x%08lX\n", (unsigned long)code);

    if (irLearnSlot >= 0) {
      irCode[irLearnSlot] = code;
      prefs.begin("heater", false);
      prefs.putULong(("ir" + String(irLearnSlot)).c_str(), code);
      prefs.end();
      Serial.printf("[IR ] saved 0x%08lX for %s\n", (unsigned long)code, irFnName[irLearnSlot]);
      irLearnSlot = -1;
      beep(2);
    } else {
      for (uint8_t i = 0; i < 9; i++)
        if (irCode[i] && irCode[i] == code) { runIrFunction(i); break; }
    }
  }
  IrReceiver.resume();
}
#endif

// ==========================================================================
// SETTINGS STORAGE
// ==========================================================================
void loadSettings() {
  prefs.begin("heater", true);
  for (uint8_t i = 0; i < DEV_COUNT; i++)
    calib[i] = prefs.getFloat(("cal" + String(i)).c_str(), 30.0);
  iLimit = prefs.getFloat("ilimit", 12.0);
  tLimit = prefs.getFloat("tlimit", 30.0);
  tempLimit = prefs.getFloat("tplimit", 85.0);
  mainsV = prefs.getFloat("mains", 230.0);
  autoFan = prefs.getBool("autofan", true);
  staSsid = prefs.getString("ssid", "");
  staPass = prefs.getString("pass", "");
  apiKey = prefs.getString("apikey", "");
  targetTemp = prefs.getFloat("target", 24.0);
  climateHysteresis = prefs.getFloat("climhys", 0.5);
  tempOffset = prefs.getFloat("tempoff", 0.0);
  meterIScale = prefs.getFloat("m_iscale", 1.0);
  for (uint8_t i = 0; i < DEV_COUNT; i++) ctMode[i] = prefs.getUChar(("ctm" + String(i)).c_str(), 0);
  fanGuard = prefs.getBool("fanguard", true);
  fanMinW  = prefs.getFloat("fanminw", 10.0f);
  meterVScale = prefs.getFloat("m_vscale", 1.0);
  for (uint8_t i = 0; i < 9; i++)
    irCode[i] = prefs.getULong(("ir" + String(i)).c_str(), 0);
#if USE_CLOUD
  cloudEnabled   = prefs.getBool("cloud_en", true);
  cloudProvKey   = prefs.getString("cloud_pk", "");
  cloudDeviceId  = prefs.getString("cloud_did", "");
  cloudDeviceKey = prefs.getString("cloud_dk", "");
#endif
  prefs.end();
}

void saveSettings() {
  prefs.begin("heater", false);
  for (uint8_t i = 0; i < DEV_COUNT; i++)
    prefs.putFloat(("cal" + String(i)).c_str(), calib[i]);
  prefs.putFloat("ilimit", iLimit);
  prefs.putFloat("tlimit", tLimit);
  prefs.putFloat("tplimit", tempLimit);
  prefs.putFloat("mains", mainsV);
  prefs.putBool("autofan", autoFan);
  prefs.putFloat("target", targetTemp);
  prefs.putFloat("climhys", climateHysteresis);
  prefs.putFloat("tempoff", tempOffset);
  prefs.putFloat("m_iscale", meterIScale);
  for (uint8_t i = 0; i < DEV_COUNT; i++) prefs.putUChar(("ctm" + String(i)).c_str(), ctMode[i]);
  prefs.putBool("fanguard", fanGuard);
  prefs.putFloat("fanminw", fanMinW);
  prefs.putFloat("m_vscale", meterVScale);
  prefs.end();
}

// ==========================================================================
// STATUS OUTPUT
// ==========================================================================
const char* faultText(uint8_t f) {
  switch (f) {
    case FLT_OVERCURRENT: return "OVER CURRENT";
    case FLT_NOLOAD: return "NO LOAD";
    case FLT_OVERTEMP: return "OVER TEMP";
    default: return "OK";
  }
}

// Escapes a string so it is safe inside a JSON "..." value. SSIDs can legally
// contain quotes, backslashes and control bytes that would break the JSON the
// mobile app parses. Used by buildJson() and the WiFi scan.
String jsonEscape(const String& in) {
  String out; out.reserve(in.length() + 8);
  for (size_t i = 0; i < in.length(); i++) {
    char c = in[i];
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if ((uint8_t)c < 0x20) break;   // drop other control chars
        out += c;
    }
  }
  return out;
}

// ==========================================================================
// PER-DEVICE POWER
// CT reading if that CT sees current; otherwise the device's share of the
// live meter watts, using the step measured when it switched ON (scaled so
// the devices always add up to the meter total). Relay ON but no power -> 0 W.
// ==========================================================================
void devicePowerTick() {
  bool live = meterOnline() && mainsV > 1;
  float otherW = 0;                         // fan + light watts
  for (uint8_t i = 4; i < DEV_COUNT; i++) {
    if (!relayActual[i]) { current[i] = 0; pwrSrc[i] = '-'; continue; }
    if (ctUsable(i) && ctAmp[i] > 0) { current[i] = ctAmp[i]; pwrSrc[i] = 'C'; otherW += ctAmp[i] * mainsV; }
    else if (learned[i] && live) { current[i] = learnW[i] / mainsV; pwrSrc[i] = 'M'; otherW += learnW[i]; }
    else { current[i] = 0; pwrSrc[i] = '?'; }
  }
  // Heaters: meter watts left after fan + light, shared between the heaters
  // that are ON. Before the drop test they share equally; after it, in
  // proportion to what each one measured (a dead heater measured 0 gets 0).
  float pool = live ? meterPower - otherW : 0;
  float avg = 0; uint8_t nl = 0;
  for (uint8_t i = 0; i < 4; i++) {
    if (!relayActual[i]) continue;
    if (ctUsable(i) && ctAmp[i] > 0) pool -= ctAmp[i] * mainsV;
    else if (learned[i] && learnW[i] > 0) { avg += learnW[i]; nl++; }
  }
  if (pool < 0) pool = 0;
  avg = nl ? avg / nl : 1.0f;
  float wSum = 0;
  for (uint8_t i = 0; i < 4; i++)
    if (relayActual[i] && !(ctUsable(i) && ctAmp[i] > 0)) wSum += learned[i] ? learnW[i] : avg;
  for (uint8_t i = 0; i < 4; i++) {
    if (!relayActual[i]) { current[i] = 0; pwrSrc[i] = '-'; }
    else if (ctUsable(i) && ctAmp[i] > 0) { current[i] = ctAmp[i]; pwrSrc[i] = 'C'; }
    else if (!live) { current[i] = 0; pwrSrc[i] = '?'; }
    else {
      float w = learned[i] ? learnW[i] : avg;
      current[i] = wSum > 0 ? pool * w / wSum / mainsV : 0;
      pwrSrc[i] = 'M';
    }
  }
}

// ==========================================================================
// DROP TEST (accurate per-device watts with ONE meter CT)
// Heaters' current changes after switch-on (cold -> warm), so the switch-ON
// jump is only a first guess. Once everything is warm, each running heater is
// switched OFF for a moment: the meter DROP = that heater's real watts. Then
// it goes straight back ON. Fan stays ON throughout; fan watts = what is left.
// Runs 60 s after heating starts, when watts don't add up, or on 'measure'.
// ==========================================================================
#define DROP_SETTLE_MS  1100   // a reading must be this much newer than the switch
#define DROP_TIMEOUT_MS 8000   // accept the latest reading after this
#define REFINE_AFTER_MS 60000  // run this long after the last heater switched ON
uint8_t  measIdx = 0;          // heater being tested
uint32_t measPhaseAt = 0;      // when the current phase started
float    measBefore = 0;       // settled meter watts with the heater ON
bool     needRefine = false;   // a heater switched ON since the last drop test
uint32_t lastHeaterOnAt = 0;

bool meterSettledSince(uint32_t t) {
  if ((int32_t)(meterLastOk - t) < (int32_t)DROP_SETTLE_MS) return false;
  if (millis() - t > DROP_TIMEOUT_MS) return true;
  return fabs(meterPower - meterPrevP) <= meterPower * 0.03f + 5.0f;
}

int8_t nextTestHeater(uint8_t from) {
  for (uint8_t i = from; i < 4; i++) if (measSaved & (1 << i)) return i;
  return -1;
}

bool startMeasure(const char* why) {
  if (measPhase || !meterOnline() || systemTrip || testRunning) return false;
  measSaved = 0;
  for (uint8_t i = 0; i < 4; i++) if (relayActual[i] && relayTarget[i]) measSaved |= (1 << i);
  bool anyOn = measSaved != 0 || relayActual[DEV_FAN] || relayActual[DEV_LIGHT];
  if (!anyOn) return false;
  if (devFault[DEV_FAN] == FLT_NOLOAD) devFault[DEV_FAN] = FLT_NONE;
  stepDev = -1; skipRunOn = false;
  int8_t h = nextTestHeater(0);
  measIdx = h < 0 ? 4 : h;
  measPhase = 1; measPhaseAt = millis(); measStartAt = millis();
  Serial.printf("[POWER] drop test (%s): each heater OFF ~3 s, one at a time, fan stays ON\n", why);
  return true;
}

void measureFinish() {
  // fan / light = what the meter shows minus all measured heaters
  float heatersW = 0;
  for (uint8_t i = 0; i < 4; i++) if (relayActual[i] && learned[i]) heatersW += learnW[i];
  float rest = meterPower - heatersW; if (rest < 0) rest = 0;
  if (relayActual[DEV_FAN]) {
    float lightW = (relayActual[DEV_LIGHT] && learned[DEV_LIGHT]) ? learnW[DEV_LIGHT] : 0;
    float w = rest - lightW;
    learnW[DEV_FAN] = w > fanMinW ? w : 0; learned[DEV_FAN] = true;
    if (learnW[DEV_FAN] > 0) Serial.printf("[POWER] FAN draws %.0f W\n", w);
    else Serial.println("[POWER] FAN relay ON but draws no power - NOT RUNNING");
    if (learnW[DEV_FAN] <= 0 && fanGuard) {
      measSaved = 0; measPhase = 0; lastMeasureAt = millis(); unexplainedSince = 0; needRefine = false;
      fanFail("fan relay ON but the fan draws no current");
      return;
    }
  } else if (relayActual[DEV_LIGHT]) {
    learnW[DEV_LIGHT] = rest > RUNNING_MIN_W ? rest : 0; learned[DEV_LIGHT] = true;
    Serial.printf("[POWER] LIGHT draws %.0f W\n", rest);
  }
  measSaved = 0; measPhase = 0; lastMeasureAt = millis(); unexplainedSince = 0; needRefine = false;
  Serial.println("[POWER] drop test done");
}

void measureAbort() {
  if (!measPhase) return;
  if (measIdx < 4 && (measSaved & (1 << measIdx))) setDev(measIdx, true);   // put it back ON
  measSaved = 0; measPhase = 0; lastMeasureAt = millis(); unexplainedSince = 0;
  Serial.println("[POWER] drop test cancelled - outputs restored");
}

void measureTick() {
  if (measPhase) {
    uint32_t now = millis();
    if (now - measStartAt > 60000) { Serial.println("[POWER] drop test timed out"); measureAbort(); return; }
    if (measIdx >= 4) { if (meterSettledSince(measPhaseAt)) measureFinish(); return; }
    uint8_t h = measIdx;
    switch (measPhase) {
      case 1:   // wait for a steady reading with heater h ON, then switch it OFF
        if (!relayActual[h] && !relayTarget[h]) {   // switched off meanwhile (fault) - skip it
          int8_t n = nextTestHeater(h + 1); measIdx = n < 0 ? 4 : n; measPhaseAt = now; return;
        }
        if (!relayActual[h] || !meterSettledSince(measPhaseAt)) return;
        measBefore = meterPower;
        relayTarget[h] = false;                     // relayTick switches it OFF
        measPhase = 2; measPhaseAt = now;
        return;
      case 2: { // heater OFF -> steady reading -> drop = its watts
        if (relayActual[h]) { measPhaseAt = now; return; }
        if (!meterSettledSince(measPhaseAt)) return;
        float w = measBefore - meterPower;
        learnW[h] = w > RUNNING_MIN_W ? w : 0; learned[h] = true;
        if (learnW[h] > 0)
          Serial.printf("[POWER] %s draws %.0f W (meter %.0f -> %.0f W when OFF)\n", devName[h], w, measBefore, meterPower);
        else
          Serial.printf("[POWER] %s relay ON but draws no power - NOT RUNNING\n", devName[h]);
        setDev(h, true);                            // straight back ON
        measPhase = 3; measPhaseAt = now;
        return;
      }
      case 3: { // heater back ON -> next heater
        if (!relayActual[h] && now - measPhaseAt < 6000) return;
        int8_t n = nextTestHeater(h + 1);
        measIdx = n < 0 ? 4 : n;
        measPhase = 1; measPhaseAt = now;
        return;
      }
    }
    return;
  }
  if (!meterOnline() || stepDev >= 0 || testRunning) { unexplainedSince = 0; return; }
  // Auto 1: heaters have been ON a while -> measure them warm and steady
  if (needRefine && anyHeaterActual() && millis() - lastHeaterOnAt > REFINE_AFTER_MS) {
    startMeasure("auto: heaters warm, measuring each one");
    return;
  }
  // Auto 2: meter shows watts that no device accounts for
  float given = 0;
  for (uint8_t i = 0; i < DEV_COUNT; i++) given += current[i] * mainsV;
  bool unexplained = fabs(meterPower - given) > UNEXPLAINED_W && meterPower > UNEXPLAINED_W;
  if (!unexplained) { unexplainedSince = 0; return; }
  if (!unexplainedSince) unexplainedSince = millis();
  if (millis() - unexplainedSince > UNEXPLAINED_MS &&
      (lastMeasureAt == 0 || millis() - lastMeasureAt > MEASURE_COOLDOWN_MS))
    startMeasure("auto: meter watts not matched to devices");
}

// ---- FAN INTERLOCK --------------------------------------------------------
bool fanConfirmed() {
  if (!fanGuard) return true;
  if (!meterOnline()) {                       // can't check without the meter
    static uint32_t warned = 0;
    if (!warned || millis() - warned > 60000) {
      warned = millis();
      Serial.println("[FAN  ] meter offline - can't confirm the fan, heaters allowed on relay timing only");
    }
    return true;
  }
  if (stepDev == DEV_FAN) return false;                   // fan switch-on step being measured - wait
  if (learned[DEV_FAN] && learnW[DEV_FAN] >= fanMinW) return true;   // confirmed (also during a drop test)
  if (measPhase) return false;                            // fan being checked - wait
  if (!learned[DEV_FAN]) {                                // fan was already ON - measure it now
    startMeasure("checking the fan before heating");
    return false;
  }
  if (learnW[DEV_FAN] >= fanMinW) return true;
  fanFail("fan relay ON but the fan draws no current");
  return false;
}

void fanFail(const char* why) {
  allOff("FAN NOT RUNNING");
  devFault[DEV_FAN] = FLT_NOLOAD;
  Serial.printf("[FAULT] %s - heaters BLOCKED for safety.\n", why);
  Serial.println("[FAULT] Check the fan wiring / fan, then turn the heat ON again.");
  beepMs(3, 300, 150);
}

const char* srcText(uint8_t i) {
  switch (pwrSrc[i]) { case 'C': return "CT"; case 'M': return "METER"; case '?': return "N/A"; default: return "-"; }
}
const char* runText(uint8_t i) {
  if (!relayActual[i]) return relayTarget[i] ? "WAITING" : "OFF";
  if (stepDev == (int8_t)i) return "MEASURING";
  if (pwrSrc[i] == '?') return "NO DATA";
  return current[i] > 0 ? "RUNNING" : "NOT RUNNING";
}

// Voltage on a device = live mains (meter reading, or the 'mains' setting)
// while its relay is ON, 0 V while OFF. Power = that voltage x its CT current.
// Voltage is shown only for a device that is REALLY running (current flowing).
// Relay ON but no current (load missing / stuck / broken) -> 0 V, NOT RUNNING.
float devVolt(uint8_t i) { return (relayActual[i] && current[i] > 0) ? mainsV : 0.0f; }

void printStatusTable() {
  const char* LINE = "==============================================================================";
  const char* SEP  = "------------------------------------------------------------------------------";
  uint32_t up = millis() / 1000;
  Serial.println(LINE);
  Serial.printf (" %s (%s)   MODE: %-6s   FW %s   UPTIME %02lu:%02lu:%02lu\n",
                 gBtName.c_str(), gFriendlyName.c_str(), levelName[heatLevel], FW_VERSION,
                 (unsigned long)(up / 3600), (unsigned long)(up / 60 % 60), (unsigned long)(up % 60));
  Serial.println(SEP);
  Serial.println(" DEVICE     GPIO RELAY STATUS        VOLT    CURRENT     POWER      ENERGY  SRC    ON-TIME  FAULT");
  Serial.println(SEP);
  double eTot = 0;
  for (uint8_t i = 0; i < DEV_COUNT; i++) {
    uint32_t onS = (relayActual[i] && onSince[i]) ? (millis() - onSince[i]) / 1000 : 0;
    const char* rl = relayActual[i] ? "ON" : (relayTarget[i] ? "WAIT" : "OFF");
    eTot += energyWh[i];
    Serial.printf(" %-10s %-4u %-5s %-11s %6.1f V %7.2f A %8.1f W %8.1f Wh  %-5s %5lu s  %s\n",
                  devName[i], relayPin[i], rl, runText(i), devVolt(i), current[i],
                  devVolt(i) * current[i], energyWh[i], srcText(i), (unsigned long)onS,
                  faultText(devFault[i]));
  }
  Serial.println(SEP);
  uint8_t nRun = 0;
  for (uint8_t i = 0; i < DEV_COUNT; i++) if (relayActual[i] && current[i] > 0) nRun++;
  Serial.printf (" %-10s %-4s %-5s %-11s %6.1f V %7.2f A %8.1f W %8.1f Wh  %-5s\n",
                 "TOTAL", "", "", (String(nRun) + " running").c_str(),
                 mainsV, totalCurrent, totalPower, eTot, overallSrc[0] == 'M' ? "METER" : "CT");
  Serial.printf (" %-10s %-4s %-5s %-11s %6s   %7.2f A %8.1f W\n",
                 "CT SUM", "", "", "", "", sumCurrent, sumCurrent * mainsV);
  Serial.println(SEP);
#if USE_ENERGY_METER
  Serial.printf (" METER  %-12s %6.1f V %7.3f A %8.1f W  %5.2f Hz  %8.2f Wh\n",
                 meterOnline() ? "ONLINE" : "NO REPLY",
                 meterVoltage, meterCurrent, meterPower, meterFreq, meterEnergy);
  {
    bool anyOn = false;
    for (uint8_t i = 0; i < DEV_COUNT; i++) if (relayActual[i]) anyOn = true;
    if (meterOnline() && anyOn && meterCurrent < 0.01f)
      Serial.println(" METER  !! outputs ON but 0 A - pass the LIVE input wire through the meter CT hole");
  }
#endif
#if USE_TEMP
  if (tempC[0] > -50)
    Serial.printf (" TEMP   %.1f C  (offset %+.1f C, limit %.0f C)%s\n",
                   tempC[0], tempOffset, tempLimit, overTempActive ? "  *** OVER TEMP ***" : "");
  else
    Serial.printf (" TEMP   SENSOR NOT FOUND (GPIO%u) - over-temp protection INACTIVE\n", TEMP_PIN_1);
#endif
  {
    String ig = "";
    for (uint8_t i = 0; i < DEV_COUNT; i++) if (!ctUsable(i)) ig += " CT" + String(i + 1);
    if (ig.length()) Serial.printf (" CT     not used:%s  (empty jack / noise - 'ctuse <n> on' when a CT is fitted)\n", ig.c_str());
  }
  Serial.printf (" LIMITS channel %.1f A | total %.1f A | temp %.0f C | mains %.0f V\n",
                 iLimit, tLimit, tempLimit, mainsV);
  Serial.printf (" FAN GUARD %s (fan must draw >= %.0f W before heaters start)\n",
                 fanGuard ? "ON" : "OFF - heaters run even if the fan is not running!", fanMinW);
  Serial.printf (" CLIMATE %-3s target %.1f C  hys %.1f C   FAN %s%s\n",
                 climateMode ? "ON" : "OFF", targetTemp, climateHysteresis,
                 relayActual[DEV_FAN] ? "ON" : "OFF",
                 fanRunOnLeft() ? (" (run-on " + String(fanRunOnLeft() / 1000) + " s)").c_str() : "");
  Serial.println(SEP);
  bool staUp = (WiFi.status() == WL_CONNECTED);
  if (staUp)
    Serial.printf (" WIFI   CONNECTED \"%s\"  IP %s  RSSI %d dBm\n",
                   WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  else
    Serial.printf (" WIFI   NOT CONNECTED  saved: %s\n",
                   staSsid.length() ? ("\"" + staSsid + "\" (retrying)").c_str() : "none - send: wifi <ssid> <pass>");
#if USE_BT
  Serial.printf (" BT     %s  (%s)\n", SerialBT.hasClient() ? "CONNECTED" : "WAITING", gBtName.c_str());
#endif
  Serial.printf (" APIKEY %s\n", apiKey.length() ? "SET" : "NOT SET - set before internet exposure");
#if USE_CLOUD
  Serial.printf (" CLOUD  %s  %s  registered: %s%s%s\n",
                 cloudEnabled ? "ON" : "OFF", cloudBaseUrl.c_str(),
                 (cloudDeviceId.length() && cloudDeviceKey.length()) ? "yes" : "no",
                 cloudLastError.length() ? "  last error: " : "", cloudLastError.c_str());
#endif
  if (climateMode && climateWhy.length()) Serial.printf (" AUTO   %s\n", climateWhy.c_str());
  if (testRunning) Serial.printf (" SELF-TEST running: step %u/4\n", testStep + 1);
  if (systemTrip)  Serial.println(" *** SYSTEM TRIPPED - send reset ***");
  Serial.println(LINE);
}

String buildJson() {
  String s = "{";
  s += "\"device\":\"" + jsonEscape(gBtName) + "\"";
  s += ",\"name\":\"" + jsonEscape(gFriendlyName) + "\"";
  s += ",\"devid\":\"" + gDeviceId + "\"";
  s += ",\"level\":" + String(heatLevel);
  s += ",\"mode\":\"" + String(levelName[heatLevel]) + "\"";
  s += ",\"manual\":" + String(manualMode ? 1 : 0);
  s += ",\"autofan\":" + String(autoFan ? 1 : 0);
  s += ",\"trip\":" + String(systemTrip ? 1 : 0);

  s += ",\"dev\":[";
  for (uint8_t i = 0; i < DEV_COUNT; i++) {
    if (i) s += ",";
    s += "{\"id\":\"" + String(devKey[i]) + "\"";
    s += ",\"name\":\"" + String(devName[i]) + "\"";
    s += ",\"on\":" + String(relayActual[i] ? 1 : 0);     // relay really ON now
    s += ",\"tgt\":" + String(relayTarget[i] ? 1 : 0);    // requested (switching in progress if different)
    s += ",\"run\":\"" + String(runText(i)) + "\"";   // RUNNING / NOT RUNNING / MEASURING / OFF
    s += ",\"src\":\"" + String(srcText(i)) + "\"";   // CT / METER / N/A
    s += ",\"v\":" + String(devVolt(i), 1);
    s += ",\"cur\":" + String(current[i], 2);
    s += ",\"pw\":" + String(devVolt(i) * current[i], 1);
    s += ",\"wh\":" + String((float)energyWh[i], 1);
    s += ",\"flt\":\"" + String(faultText(devFault[i])) + "\"}";
  }
  s += "]";

  s += ",\"total\":" + String(totalCurrent, 2);
  s += ",\"power\":" + String(totalPower, 1);
  s += ",\"sum\":" + String(sumCurrent, 2);
  s += ",\"src\":\"" + String(overallSrc) + "\"";
  s += ",\"mv\":" + String(meterVoltage, 1);
  s += ",\"mi\":" + String(meterCurrent, 2);     // meter current A
  s += ",\"mp\":" + String(meterPower, 1);       // meter power W
  s += ",\"mwh\":" + String(meterEnergy, 2);     // meter energy Wh
  s += ",\"mhz\":" + String(meterFreq, 1);       // mains frequency Hz
  s += ",\"mains\":" + String(mainsV, 0);
  s += ",\"temp\":[" + String(tempC[0], 1) + "]";
  s += ",\"tmax\":" + String(maxTemp, 1);
  s += ",\"tempoffset\":" + String(tempOffset, 1);
  s += ",\"ilimit\":" + String(iLimit, 1);
  s += ",\"tlimit\":" + String(tLimit, 1);
  s += ",\"templimit\":" + String(tempLimit, 0);
  bool staUp = (WiFi.status() == WL_CONNECTED);
  s += ",\"wifi\":\"" + String(staUp ? "STA" : "AP") + "\"";
  s += ",\"ip\":\"" + String(staUp ? WiFi.localIP().toString()
                                    : WiFi.softAPIP().toString()) + "\"";
  // Router link quality for the app's "connected" icon. rssi in dBm
  // (about -30 strong .. -90 weak); 0 = not joined to a router.
  s += ",\"rssi\":" + String(staUp ? WiFi.RSSI() : 0);
  s += ",\"ssid\":\"" + jsonEscape(staUp ? WiFi.SSID() : String("")) + "\"";
  // Router join state for the app: none | connecting | connected | failed
  const char* wst = staUp ? "connected" : (staSsid.length() == 0 ? "none" :
                    (millis() - wifiAttemptAt < 20000 ? "connecting" : "failed"));
  s += ",\"wifist\":\"" + String(wst) + "\"";
  s += ",\"savedssid\":\"" + jsonEscape(staSsid) + "\"";
#if USE_BT
  s += ",\"bt\":" + String(SerialBT.hasClient() ? 1 : 0);
#else
  s += ",\"bt\":0";
#endif
  s += ",\"keyset\":" + String(apiKey.length() ? 1 : 0);
  s += ",\"climate\":" + String(climateMode ? 1 : 0);
  s += ",\"target\":" + String(targetTemp, 1);
  s += ",\"hys\":" + String(climateHysteresis, 1);
  s += ",\"climwhy\":\"" + jsonEscape(climateMode ? climateWhy : String("")) + "\"";
  s += ",\"fanuser\":" + String(fanUser ? 1 : 0);
  s += ",\"runon\":" + String(fanRunOnLeft() / 1000);        // fan run-on seconds left
  s += ",\"overtemp\":" + String(overTempActive ? 1 : 0);
  s += ",\"testrun\":" + String(testRunning ? 1 : 0);
  s += ",\"teststep\":" + String(testRunning ? testStep + 1 : 0);
  s += ",\"fw\":\"" FW_VERSION "\"";
  s += ",\"otaState\":\"" + jsonEscape(otaState) + "\"";      // app shows progress / errors
  s += ",\"otaPct\":" + String(otaPct);
  s += ",\"otaAvail\":\"" + jsonEscape(otaAvailVer) + "\"";   // non-empty -> show "Update available"
  s += ",\"otaNotes\":\"" + jsonEscape(otaAvailNotes) + "\"";
#if USE_CLOUD
  s += ",\"cloud\":" + String(cloudEnabled ? 1 : 0);
  s += ",\"cloudreg\":" + String((cloudDeviceId.length() && cloudDeviceKey.length()) ? 1 : 0);
#endif
  s += ",\"up\":" + String(millis() / 1000);
  s += "}";
  return s;
}

// ==========================================================================
// COMMAND PARSER (shared by Serial / BT / WiFi)
// ==========================================================================
String climateOnReply() {
  bool ok = maxTemp > -50 && maxTemp < 200;
  if (!ok) return "AUTO-COMFORT ON - but NO TEMPERATURE SENSOR found, so heaters stay OFF. Check DS18B20 on GPIO21 (4.7k pull-up DQ to 3.3V).";
  if (maxTemp >= targetTemp)
    return "AUTO-COMFORT ON - room " + String(maxTemp, 1) + " C is already at/above target " + String(targetTemp, 1) +
           " C, so heaters stay OFF. Raise the target (settemp) to heat.";
  return "AUTO-COMFORT ON - room " + String(maxTemp, 1) + " C, target " + String(targetTemp, 1) + " C - heating (fan first)";
}

String handleCommand(String cmd, const char* src) {
  cmd.trim();
  if (cmd.length() == 0) return "";
  String lc = cmd; lc.toLowerCase();
  if (src[0] == 'B' && btConnectedAt)
    Serial.printf("[CMD ] (%s) t=%lus (%lus after BT connect) %s\n", src,
                  (unsigned long)(millis() / 1000), (unsigned long)((millis() - btConnectedAt) / 1000), cmd.c_str());
  else
    Serial.printf("[CMD ] (%s) t=%lus %s\n", src, (unsigned long)(millis() / 1000), cmd.c_str());
  // ---- reconnect guard: block automatic re-sent ON commands -------------
  {
    bool turnsOn =
      lc == "heat low" || lc == "low" || lc == "heat med" || lc == "med" || lc == "medium" ||
      lc == "heat medium" || lc == "heat high" || lc == "high" || lc == "up" ||
      lc == "fan on" || lc == "fan" || lc == "light on" || lc == "light" ||
      lc == "climate on" || lc == "auto on" || lc == "climate" || lc == "climate toggle" ||
      lc == "auto toggle" || lc == "test" ||
      (lc.length() == 5 && lc[0] == 'h' && lc.endsWith(" on"));          // h1 on .. h4 on
    bool fromApp = (src[0] == 'B') || (src[0] == 'W');
    bool justConnected = (src[0] == 'B' && btConnectedAt && millis() - btConnectedAt < GUARD_MS) ||
                         millis() - mainsBackAt < POWERUP_LOCK_MS;     // first 60 s after power returns
    // After a power cut the app's FIRST ON command is always treated as an
    // automatic restore and ignored - whenever it arrives. A real person
    // simply taps again.
    bool firstAfterPowerUp = !bootArmed;
    if (APP_GUARD && turnsOn && fromApp && (justConnected || firstAfterPowerUp)) {
      bootArmed = true;
      Serial.printf("[GUARD] ignored '%s' from %s - sent automatically right after (re)connect. Tap again to turn on.\n",
                    cmd.c_str(), src);
      return "IGNORED - app re-sent '" + cmd + "' automatically after reconnect. Tap the button again to turn on.";
    }
  }

#if USE_CLOUD
  if (lc == "ota" || lc.startsWith("ota ")) return otaCommand(lc, cmd);
#endif

  if (lc == "measure") {
    return startMeasure("command") ? "RE-MEASURE started - heaters OFF, then back ON one by one (fan stays ON)"
                                   : "Can't measure: meter offline / no output ON / already measuring";
  }
  {
    bool readOnly = lc == "status" || lc == "json" || lc == "help" || lc.startsWith("print") ||
                    lc == "wifiinfo" || lc == "wifiscan" || lc == "irlist" || lc == "cloud" ||
                    lc == "apikey" || lc == "metercal" || lc == "ctuse" || lc == "ota" || lc == "ota check" || lc == "fanguard";
    if (!readOnly) measureAbort();  // a command that changes outputs cancels a re-measure first
  }

  // ---- heat level -------------------------------------------------------
  String climateOverrideMsg = "";
  bool wasManualHeatCmd =
    lc == "heat off" || lc == "off" || lc == "heat low" || lc == "low" ||
    lc == "heat med" || lc == "med" || lc == "medium" || lc == "heat medium" ||
    lc == "heat high" || lc == "high" || lc == "up" || lc == "down";
  if (wasManualHeatCmd && climateMode) {
    climateMode = false;
    climateOverrideMsg = " (auto-comfort mode turned OFF)";
    Serial.println("[CLIM ] auto-comfort mode cancelled by manual command");
  }
  if (wasManualHeatCmd) { testRunning = false; testStep = 0; testStepStart = 0; }

  if (lc == "heat off" || lc == "off") { applyLevel(LVL_OFF); return "HEAT OFF" + climateOverrideMsg; }
  if (lc == "heat low" || lc == "low") { applyLevel(LVL_LOW); return "LOW - 1 heater ON (fan first)" + climateOverrideMsg; }
  if (lc == "heat med" || lc == "med" || lc == "medium" || lc == "heat medium")
    { applyLevel(LVL_MED); return "MEDIUM - 2 heaters ON (fan first)" + climateOverrideMsg; }
  if (lc == "heat high" || lc == "high") { applyLevel(LVL_HIGH); return "HIGH - 4 heaters ON (fan first)" + climateOverrideMsg; }
  if (lc == "up") { applyLevel(heatLevel < LVL_HIGH ? heatLevel + 1 : LVL_HIGH); return String(levelName[heatLevel]) + climateOverrideMsg; }
  if (lc == "down") { applyLevel(heatLevel > LVL_OFF ? heatLevel - 1 : LVL_OFF); return String(levelName[heatLevel]) + climateOverrideMsg; }

  // ---- fan / light ------------------------------------------------------
  // FAN IS MASTER: fan off = all heaters off, auto-comfort cancelled.
  if (lc == "fan on") { return fanOnRequest() ? "FAN ON" : "FAN can't start - fault or TRIPPED, send 'reset'"; }
  if (lc == "fan off") { fanOffKillsHeaters(); return "FAN OFF - all heaters OFF"; }
  if (lc == "fan") {
    if (relayTarget[DEV_FAN]) { fanOffKillsHeaters(); return "FAN OFF - all heaters OFF"; }
    return fanOnRequest() ? "FAN ON" : "FAN can't start - fault or TRIPPED, send 'reset'";
  }
  if (lc == "light on") { setDev(DEV_LIGHT, true); return "LIGHT ON"; }
  if (lc == "light off") { setDev(DEV_LIGHT, false); return "LIGHT OFF"; }
  if (lc == "light") { setDev(DEV_LIGHT, !relayTarget[DEV_LIGHT]);
                       return relayTarget[DEV_LIGHT] ? "LIGHT ON" : "LIGHT OFF"; }

  // ---- individual heaters -------------------------------------------------
  for (uint8_t i = 0; i < 4; i++) {
    String k = "h" + String(i + 1);
    if (lc == k + " on") {
      climateMode = false; testRunning = false;
      if (!heaterAvailable(i)) { beep(3); return String(devName[i]) + " can't start - fault / fan / over-temp / TRIPPED"; }
      setDev(i, true); manualMode = true; recalcLevelFromRelays();
      beep(1); return String(devName[i]) + " ON (fan first)";
    }
    if (lc == k + " off") {
      climateMode = false; testRunning = false;
      setDev(i, false); manualMode = true; recalcLevelFromRelays();
      beep(1); return String(devName[i]) + " OFF";
    }
  }

  if (lc == "all off") { climateMode = false; allOff("command"); beep(1); return "ALL OUTPUTS OFF"; }

  // ---- heater self-test ---------------------------------------------------
  if (lc == "test") { startSelfTest(); return "SELF-TEST STARTED - fan first, then H1..H4, 2000ms each"; }

  // ---- info -------------------------------------------------------------
  if (lc == "status") { printStatusTable(); return "STATUS PRINTED ON SERIAL"; }
  if (lc == "json") { String j = buildJson(); Serial.println(j); return j; }
  if (lc == "print on") { autoPrint = true; return "AUTO PRINT ON"; }
  if (lc == "print off") { autoPrint = false; return "AUTO PRINT OFF"; }

  if (lc == "reset") {
    systemTrip = false;
    for (uint8_t i = 0; i < DEV_COUNT; i++)
      if (!(overTempActive && devFault[i] == FLT_OVERTEMP)) devFault[i] = FLT_NONE;
    beep(2);
    return overTempActive ? "FAULTS CLEARED - still OVER TEMP, heaters stay off until it cools"
                          : "FAULTS CLEARED";
  }

  // ---- settings ---------------------------------------------------------
  if (lc.startsWith("cal ")) {
    int sp = lc.indexOf(' ', 4);
    if (sp > 0) {
      int ch = lc.substring(4, sp).toInt();
      float v = lc.substring(sp + 1).toFloat();
      if (ch >= 1 && ch <= 6 && v > 0) {
        calib[ch - 1] = v; saveSettings();
        return "CT" + String(ch) + " calibration = " + String(v, 2);
      }
    }
    return "usage: cal <1-6> <value>";
  }
  if (lc.startsWith("ilimit ")) { iLimit = lc.substring(7).toFloat(); saveSettings();
                                  return "Channel limit = " + String(iLimit, 1) + " A"; }
  if (lc.startsWith("tlimit ")) { tLimit = lc.substring(7).toFloat(); saveSettings();
                                  return "Total limit = " + String(tLimit, 1) + " A"; }
  if (lc.startsWith("templimit ")) { tempLimit = lc.substring(10).toFloat(); saveSettings();
                                     return "Temp limit = " + String(tempLimit, 0) + " C"; }
  if (lc.startsWith("mains ")) { mainsV = lc.substring(6).toFloat(); saveSettings();
                                 return "Mains voltage = " + String(mainsV, 0) + " V"; }
  if (lc == "autofan on") { autoFan = true; saveSettings(); return "AUTO FAN ON"; }
  if (lc == "autofan off") { autoFan = false; saveSettings(); return "AUTO FAN OFF (fan still forces ON whenever a heater is on)"; }

  // ---- ROOM TEMPERATURE CALIBRATION ---------------------------------------
  // ---- ENERGY METER CALIBRATION -------------------------------------------
  // Run a steady load, read it with your clamp meter / multimeter, then send
  // meteri 1.62   (amps)   or   meterv 229.5  (volts). "metercal reset" undoes it.
  if (lc.startsWith("meteri ")) {
    float a = lc.substring(7).toFloat();
    if (a <= 0) return "usage: meteri <amps measured with clamp meter>";
    if (meterIRaw < 0.01f) return "Meter reads 0 A - no current through the meter CT. Pass the LIVE wire through the CT hole first.";
    meterIScale = a / meterIRaw; saveSettings();
    return "Meter current calibrated: scale " + String(meterIScale, 4);
  }
  if (lc.startsWith("meterv ")) {
    float v = lc.substring(7).toFloat();
    if (v < 50 || v > 300) return "usage: meterv <volts measured with multimeter, 50-300>";
    if (meterVRaw < 10) return "Meter voltage not available yet";
    meterVScale = v / meterVRaw; saveSettings();
    return "Meter voltage calibrated: scale " + String(meterVScale, 4);
  }
  if (lc.startsWith("ctuse ")) {
    int ch = lc.substring(6).toInt();
    String m = lc.substring(lc.lastIndexOf(' ') + 1);
    if (ch < 1 || ch > 6 || !(m == "auto" || m == "on" || m == "off"))
      return "usage: ctuse <1-6> auto|on|off   (off = jack empty, on = CT fitted)";
    ctMode[ch - 1] = (m == "on") ? 1 : (m == "off") ? 2 : 0;
    ctNoisy[ch - 1] = false; saveSettings();
    return "CT" + String(ch) + " = " + m;
  }
  if (lc == "ctuse") {
    String r = "";
    for (uint8_t i = 0; i < DEV_COUNT; i++)
      r += "CT" + String(i + 1) + ":" + String(ctMode[i] == 1 ? "on" : ctMode[i] == 2 ? "off" : (ctNoisy[i] ? "auto(IGNORED)" : "auto")) + " ";
    return r;
  }
  if (lc == "fanguard on")  { fanGuard = true;  saveSettings(); return "FAN GUARD ON - heaters start only when the fan is confirmed running"; }
  if (lc == "fanguard off") { fanGuard = false; saveSettings(); return "FAN GUARD OFF - WARNING: heaters can run without the fan (bench test only)"; }
  if (lc == "fanguard")     return String("FAN GUARD ") + (fanGuard ? "ON" : "OFF") + ", fan minimum " + String(fanMinW, 0) + " W";
  if (lc.startsWith("fanmin ")) {
    float w = lc.substring(7).toFloat();
    if (w < 2 || w > 500) return "usage: fanmin <2-500>  (watts the fan must draw to count as running)";
    fanMinW = w; saveSettings();
    return "Fan counts as running from " + String(fanMinW, 0) + " W";
  }
  if (lc == "energy reset") {
    for (uint8_t i = 0; i < DEV_COUNT; i++) energyWh[i] = 0;
    return "Per-device energy counters reset to 0 Wh";
  }
  if (lc == "metercal reset") { meterIScale = meterVScale = 1.0f; saveSettings(); return "Meter calibration reset to 1.0"; }
  if (lc == "metercal") return "Meter scales: current " + String(meterIScale, 4) + "  voltage " + String(meterVScale, 4);

  if (lc.startsWith("tempoffset ")) {
    float v = lc.substring(11).toFloat();
    if (v < -10 || v > 10) return "usage: tempoffset <-10 to 10> (added to every raw DS18B20 reading to correct calibration)";
    tempOffset = v; saveSettings();
    return "Temp offset set = " + String(tempOffset, 1) + " C (applied from the next reading, ~2s)";
  }

  // ---- AUTO-COMFORT MODE ---------------------------------------------------
  if (lc == "climate on" || lc == "auto on") {
    if (systemTrip) return "Can't enable auto-comfort while system is TRIPPED - send 'reset' first";
    climateMode = true; climateCheckNow = true;
    beep(2);
    return climateOnReply();
  }
  if (lc == "climate off" || lc == "auto off") {
    climateMode = false;
    beep(1);
    return "AUTO-COMFORT OFF - manual control";
  }
  if (lc == "climate" || lc == "climate toggle" || lc == "auto toggle") {   // toggle - keeps saved target
    if (climateMode) { climateMode = false; beep(1); return "AUTO-COMFORT OFF - manual control"; }
    if (systemTrip) return "Can't enable auto-comfort while system is TRIPPED - send 'reset' first";
    climateMode = true; climateCheckNow = true; beep(2);
    return climateOnReply();
  }
  if (lc.startsWith("settemp ")) {
    float v = lc.substring(8).toFloat();
    if (v < 10 || v > 60) return "usage: settemp <10-60> (target room temp - saved, kept after reboot)";
    targetTemp = v; saveSettings();
    climateCheckNow = true; // re-check against the new target right away if climate mode is on
    return "Target set = " + String(targetTemp, 1) + " C" + String(climateMode ? " (auto-comfort ON)" : " (auto-comfort is OFF - send climate on)");
  }
  if (lc.startsWith("sethys ")) {
    float v = lc.substring(7).toFloat();
    if (v < 0.1 || v > 2.0) return "usage: sethys <0.1-2.0> (deadband C around target - smaller holds tighter; capped at 2.0 so it can't overlap the MEDIUM band)";
    climateHysteresis = v; saveSettings();
    climateCheckNow = true;
    return "Hysteresis set = " + String(climateHysteresis, 1) + " C";
  }

  // ---- API KEY -----------------------------------------------------------
  if (lc.startsWith("apikey ")) {
    String val = cmd.substring(7); val.trim();
    String valLc = val; valLc.toLowerCase();
    if (valLc == "clear") val = "";
    apiKey = val;
    prefs.begin("heater", false);
    prefs.putString("apikey", apiKey);
    prefs.end();
    apiKeyWarned = false;
    if (apiKey.length())
      return "API key saved. Add &key=" + apiKey + " to every web/API request.";
    else
      return "API key CLEARED - web API is now OPEN. Do not expose it to the internet like this.";
  }
  if (lc == "apikey") {
    return apiKey.length() ? "API key is SET (web API protected)."
                           : "API key is NOT SET - web API is OPEN. Set one with: apikey <secret>";
  }

  // ---- CLOUD TELEMETRY (online web app) ------------------------------------
#if USE_CLOUD
  if (lc == "cloud on") {
    cloudEnabled = true; saveCloud(); tCloud = 0;   // 0 = try right away
    return "CLOUD reporting ON (" + cloudBaseUrl + ")";
  }
  if (lc == "cloud off") { cloudEnabled = false; saveCloud(); return "CLOUD reporting OFF"; }
  if (lc == "cloud") {
    String r = "CLOUD " + String(cloudEnabled ? "ON" : "OFF");
    r += "  server: " + cloudBaseUrl;
    r += "  registered: " + String(cloudDeviceId.length() ? "yes" : "no");
    if (cloudLastError.length()) r += "  last error: " + cloudLastError;
    return r;
  }
  if (lc.startsWith("cloudkey ")) {
    cloudProvKey = cmd.substring(9); cloudProvKey.trim(); saveCloud();
    return cloudProvKey.length() ? "Cloud provisioning key set" : "Cloud provisioning key cleared";
  }
  if (lc == "cloudreg") {
    cloudDeviceId = ""; cloudDeviceKey = ""; saveCloud(); tCloud = 0;
    return "Cloud will re-register on the next report";
  }
#endif

  // ---- wifi -------------------------------------------------------------
  if (lc.startsWith("wifi ")) {
    String rest = cmd.substring(5); rest.trim();
    if (rest.length()) {
      String ssid, pass;
      if (rest.startsWith("\"")) {
        // Quoted SSID: wifi "my network" password  - allows spaces in the SSID.
        int close = rest.indexOf('"', 1);
        if (close < 1) return "usage: wifi \"<ssid>\" <password>  (missing closing quote)";
        ssid = rest.substring(1, close);
        pass = rest.substring(close + 1); pass.trim();
      } else {
        int sp = rest.indexOf(' ');
        if (sp > 0) { ssid = rest.substring(0, sp); pass = rest.substring(sp + 1); }
        else        { ssid = rest; pass = ""; }   // open network, no password
      }
      staSsid = ssid; staPass = pass;
      prefs.begin("heater", false);
      prefs.putString("ssid", staSsid);
      prefs.putString("pass", staPass);
      prefs.end();
      // Defer WiFi.begin() so this reply reaches the app first. Calling it
      // inline reconfigures the radio and can drop the phone on the hotspot
      // before it gets the HTTP response.
      wifiApplyPending = true;
      wifiApplyAt = millis() + 700;
      return "WiFi saved, connecting to " + staSsid;
    }
    return "usage: wifi <ssid> <password>";
  }
  if (lc == "wifiinfo") {
    String r = "SSID: " + (staSsid.length() ? staSsid : String("-"));
    r += " STATE: " + String(WiFi.status() == WL_CONNECTED ? "CONNECTED" : "AP MODE");
    r += " IP: " + String(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString()
                                                        : WiFi.softAPIP().toString());
    r += USE_HOTSPOT ? " AP: " + gApSsid + " / " + String(AP_PASS) : String(" HOTSPOT: OFF");
    r += " API KEY: " + String(apiKey.length() ? "SET" : "NOT SET");
    Serial.println(r);
    return r;
  }
#if USE_WIFI
  // Nearby WiFi list as JSON. Over Serial/BT this JSON line IS the reply.
  // Over WiFi the app must use GET /api/wifiscan instead (/api/cmd rewrites
  // quotes in the reply text, which would corrupt the JSON).
  if (lc == "wifiscan") {
    if (src[0] == 'W') return buildWifiScanJson(false);    // web: blocking, BT untouched
    startAsyncScan(src[0] == 'B' ? 2 : 1);                  // BT / Serial: background
    return "";                                              // the list follows as the next line
  }
#endif

  // ---- IR ---------------------------------------------------------------
  if (lc.startsWith("irlearn ")) {
    int s = lc.substring(8).toInt();
    if (s >= 0 && s <= 8) { irLearnSlot = s; beep(1);
                            return "Press remote key for: " + String(irFnName[s]); }
    return "usage: irlearn <0-8>";
  }
  if (lc == "irlist") {
    String r = "";
    for (uint8_t i = 0; i < 9; i++) {
      r += String(i) + " " + irFnName[i] + " = 0x" + String(irCode[i], HEX) + "\n";
    }
    Serial.print(r);
    return r;
  }

  if (lc == "help") {
    String r = "heat off/low/med/high | up | down | fan on/off (fan off = ALL heaters off) | light on/off | "
               "h1..h4 on/off (fan comes ON first) | all off | "
               "test (self-test: fan first, H1..H4, 2000ms each) | status | json | reset | "
               "cal <ch> <v> | ilimit <A> | tlimit <A> | templimit <C> | mains <V> | autofan on/off | "
               "tempoffset <-10..10> (calibrate DS18B20 room temp reading) | "
               "meteri <A> | meterv <V> | metercal [reset] (calibrate energy meter to a clamp meter) | "
               "measure (re-check which device uses how many watts) | ctuse <1-6> auto|on|off | ctuse | energy reset | "
               "ota | ota check | ota install | ota url <link> (wireless firmware update) | "
               "fanguard on|off | fanmin <W> (heaters only start when the fan is really running) | "
               "apikey <secret>|clear (protects web API - required before internet exposure) | "
               "settemp <10-60> (target room temp, saved) | "
               "climate on/off/toggle (auto-comfort, OFF at boot - turn on manually; also via app / dashboard / IR slot 8) | "
               "sethys <0.1-2.0> (deadband around target) | "
               "wifi <ssid> <pass> | wifiinfo | wifiscan (list nearby networks) | cloud on/off | cloud (status) | cloudkey <key> | cloudreg | irlearn <0-8> | irlist | print on/off";
    Serial.println(r);
    return r;
  }

  return "UNKNOWN COMMAND - send 'help'";
}

// ==========================================================================
// WEB DASHBOARD
// ==========================================================================
#if USE_WIFI
// %DEVICE_NAME% is replaced with the real DEVICE_NAME at request time in
// webRoot(), so the page title and header show which physical board this
// is - two boards from the same source now display distinctly different
// pages in the browser instead of both saying "HEATER VER1".
const char PAGE_HTML[] PROGMEM = R"HTML(<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>%DEVICE_NAME%</title><style>
*{box-sizing:border-box}
body{margin:0;padding:14px;background:#12100e;color:#f0e6da;
font-family:ui-monospace,Menlo,Consolas,monospace;-webkit-tap-highlight-color:transparent}
h1{font-size:15px;letter-spacing:.22em;margin:0 0 2px;color:#ff8a3d;font-weight:700}
.sub{font-size:11px;color:#8a7f74;margin-bottom:14px}
.card{background:#1c1917;border:1px solid #322c27;border-radius:10px;padding:12px;margin-bottom:10px}
.lbl{font-size:10px;letter-spacing:.18em;color:#8a7f74;margin-bottom:8px}
.big{font-size:40px;font-weight:700;line-height:1;color:#ffb35c}
.big span{font-size:15px;color:#8a7f74;margin-left:4px}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
button{font-family:inherit;font-size:12px;letter-spacing:.1em;padding:14px 6px;border-radius:8px;
border:1px solid #3d352e;background:#241f1b;color:#f0e6da;cursor:pointer;width:100%}
button:active{transform:scale(.97)}
button.on{background:#ff8a3d;border-color:#ff8a3d;color:#1a1512;font-weight:700}
button:focus-visible{outline:2px solid #ffb35c;outline-offset:2px}
.hint{display:block;font-size:9px;color:#8a7f74;margin-top:3px;letter-spacing:.05em}
button.on .hint{color:#5a3a1c}
.d{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #262220;font-size:12px}
.d:last-child{border:0}
.dot{width:8px;height:8px;border-radius:50%;background:#3d352e;flex:none}
.dot.on{background:#4ade80;box-shadow:0 0 8px #4ade8088}
.dot.f{background:#f05a5a;box-shadow:0 0 8px #f05a5a88}
.nm{flex:1}.am{color:#ffb35c;width:66px;text-align:right}
.pw{color:#8a7f74;width:70px;text-align:right}
.bar{height:3px;background:#262220;border-radius:2px;margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%;background:#ff8a3d;width:0}
.pill{font-size:10px;padding:3px 8px;border-radius:20px;background:#241f1b;border:1px solid #3d352e;color:#8a7f74}
.pill.ok{color:#4ade80;border-color:#2c4a35}
.pill.warn{color:#f0c040;border-color:#5a4a1c}
.alert{background:#3a1614;border-color:#7a2a24;color:#ffb0a8;font-size:12px}
.tval{font-size:32px;font-weight:700;color:#ffb35c}
.tval span{font-size:14px;color:#8a7f74;margin-left:4px}
</style></head><body>
<h1>%DEVICE_NAME%</h1>
<div class="sub" id="sub">connecting...</div>
<div id="alert"></div>

<div class="card"><div class="row">
<div><div class="lbl">OVERALL CURRENT <span id="src"></span></div><div class="big"><span id="tc">0.00</span><span>A</span></div></div>
<div style="text-align:right"><div class="lbl">TOTAL POWER</div>
<div class="big" style="font-size:26px"><span id="tp">0</span><span>W</span></div></div>
</div><div class="bar"><i id="tbar"></i></div></div>

<div class="card"><div class="lbl">HEAT LEVEL (fan starts first)</div><div class="grid">
<button id="b0" onclick="c('heat off')">OFF<span class="hint">no heater</span></button>
<button id="b1" onclick="c('heat low')">LOW<span class="hint">1 heater</span></button>
<button id="b2" onclick="c('heat med')">MEDIUM<span class="hint">2 heaters</span></button>
<button id="b3" onclick="c('heat high')">HIGH<span class="hint">4 heaters</span></button>
</div></div>

<div class="card"><div class="lbl">FAN &amp; LIGHT (fan OFF = all heaters OFF)</div><div class="grid">
<button id="bf" onclick="c('fan')">FAN</button>
<button id="bl" onclick="c('light')">LIGHT</button>
</div></div>

<div class="card"><div class="row">
<div><div class="lbl">AUTO-COMFORT MODE</div><div style="font-size:18px;font-weight:700" id="climstate">OFF</div></div>
<button id="climbtn" style="width:auto;padding:10px 18px" onclick="toggleClimate()">TOGGLE</button>
</div>
<div class="row" style="margin-top:10px">
<div><div class="lbl">TARGET TEMP</div><div class="tval"><span id="targetval">--</span><span>&deg;C</span></div></div>
<button style="width:auto;padding:10px 18px" onclick="setTarget()">SET TARGET TEMP</button>
</div>
<div class="row" style="margin-top:10px">
<div><div class="lbl">HYSTERESIS</div><div class="tval" style="font-size:20px"><span id="hysval">--</span><span>&deg;C</span></div></div>
<button style="width:auto;padding:10px 18px" onclick="setHys()">SET HYSTERESIS</button>
</div>
<div class="lbl" style="margin-top:8px">holds at target using the hysteresis band, steps LOW / MEDIUM / HIGH below it (fan starts first)</div>
</div>

<div class="card"><div class="lbl">DEVICE CURRENT</div><div id="devs"></div></div>

<div class="card"><div class="row">
<div><div class="lbl">ROOM TEMPERATURE (DS18B20)</div><div class="tval"><span id="temp1">--</span><span>&deg;C</span></div></div>
</div>
<div style="margin-top:8px"><button onclick="setTempOffset()">CALIBRATE TEMP OFFSET</button></div>
</div>

<div class="card"><div class="lbl">MANUAL HEATERS</div><div class="grid">
<button id="h1" onclick="t('h1')">HEATER 1</button>
<button id="h2" onclick="t('h2')">HEATER 2</button>
<button id="h3" onclick="t('h3')">HEATER 3</button>
<button id="h4" onclick="t('h4')">HEATER 4</button>
</div>
<div style="margin-top:8px"><button onclick="c('test')">RUN SELF-TEST (fan, then H1..H4, 2s each)</button></div>
<div style="margin-top:8px"><button onclick="c('all off')">ALL OUTPUTS OFF</button></div>
<div style="margin-top:8px"><button onclick="c('reset')">CLEAR FAULTS</button></div>
<div style="margin-top:8px"><button onclick="changeKey()">SET / CHANGE ACCESS KEY</button></div>
</div>
<script>
var st={};
var HKEY = localStorage.getItem('hkey') || '';
function changeKey(){
var v = prompt('Enter the heater access key (leave blank if none is set on the device):', HKEY || '');
if (v !== null){ HKEY = v; localStorage.setItem('hkey', HKEY); poll(); }
}
function withKey(url){ return url + (url.indexOf('?')>=0?'&':'?') + 'key=' + encodeURIComponent(HKEY); }
function c(x){
fetch(withKey('/api/cmd?c='+encodeURIComponent(x))).then(function(r){
if(r.status===401){ changeKey(); return null; }
return r.json();
}).then(function(j){ if(j) render(j); })
}
function t(id){var d=(st.dev||[]).find(v=>v.id==id);c(id+(d&&d.on?' off':' on'))}
function toggleClimate(){ c(st.climate ? 'climate off' : 'climate on') }
function setTarget(){
var v = prompt('Target room temperature (10-60 C):', st.target!==undefined?st.target:24);
if (v !== null && v.trim() !== '') c('settemp ' + v.trim());
}
function setHys(){
var v = prompt('Hysteresis / deadband around target (0.1-2.0 C, smaller = holds tighter):', st.hys!==undefined?st.hys:0.5);
if (v !== null && v.trim() !== '') c('sethys ' + v.trim());
}
function setTempOffset(){
var v = prompt('Temperature calibration offset in C, added to the raw sensor reading (-10 to 10):', st.tempoffset!==undefined?st.tempoffset:0);
if (v !== null && v.trim() !== '') c('tempoffset ' + v.trim());
}
function render(j){
st=j;
document.getElementById('tc').textContent=j.total.toFixed(2);
document.getElementById('tp').textContent=Math.round(j.power);
document.getElementById('src').textContent='('+j.src+')';
document.getElementById('tbar').style.width=Math.min(100,j.total/j.tlimit*100)+'%';
document.getElementById('sub').innerHTML='<span class="pill '+(j.wifi=='STA'?'ok':'')+'">WIFI '+j.wifi+
'</span> <span class="pill '+(j.bt?'ok':'')+'">BT '+(j.bt?'LINK':'READY')+
'</span> <span class="pill">'+j.ip+'</span> <span class="pill">'+j.mode+'</span>'+
' <span class="pill '+(j.keyset?'ok':'warn')+'">KEY '+(j.keyset?'PROTECTED':'NOT SET')+'</span>'+
(j.testrun?' <span class="pill warn">TEST '+j.teststep+'/4</span>':'');
for(var i=0;i<4;i++){document.getElementById('b'+i).className=(j.level==i?'on':'')}
var h='',mx=Math.max(1,j.ilimit);
j.dev.forEach(function(d){
h+='<div class="d"><span class="dot '+(d.flt!='OK'?'f':(d.on?'on':''))+'"></span>'+
'<span class="nm">'+d.name+(d.flt!='OK'?' <span style="color:#f05a5a">'+d.flt+'</span>':'')+'</span>'+
'<span class="am">'+d.cur.toFixed(2)+' A</span><span class="pw">'+Math.round(d.pw)+' W</span></div>';
});
document.getElementById('devs').innerHTML=h;
document.getElementById('climstate').textContent = j.climate ? ('ON' + (j.climwhy ? ' - ' + j.climwhy : '')) : 'OFF';
document.getElementById('climstate').style.color = j.climate ? '#4ade80' : '#8a7f74';
document.getElementById('climbtn').className = j.climate ? 'on' : '';
document.getElementById('climbtn').textContent = j.climate ? 'TURN OFF' : 'TURN ON';
document.getElementById('targetval').textContent = j.target.toFixed(1);
document.getElementById('hysval').textContent = j.hys.toFixed(1);
var f=j.dev.find(d=>d.id=='fan'),l=j.dev.find(d=>d.id=='light');
document.getElementById('bf').className=f&&f.on?'on':'';
document.getElementById('bl').className=l&&l.on?'on':'';
for(var i=1;i<=4;i++){var d=j.dev.find(v=>v.id=='h'+i);
document.getElementById('h'+i).className=d&&d.on?'on':''}
document.getElementById('temp1').textContent=(j.temp[0]<-50?'--':j.temp[0].toFixed(1));
var a='';
if(j.trip)a='<div class="card alert">SYSTEM TRIPPED on total over current. Check the load, then press CLEAR FAULTS.</div>';
document.getElementById('alert').innerHTML=a;
}
function poll(){
fetch(withKey('/api/status')).then(function(r){
if(r.status===401){ changeKey(); return null; }
return r.json();
}).then(function(j){ if(j) render(j); }).catch(function(){})
}
setInterval(poll,1000);poll();
</script></body></html>)HTML";

bool checkAuth() {
  if (apiKey.length() == 0) {
    if (!apiKeyWarned) {
      Serial.println("[WARN ] No API key set - web API is OPEN to anyone who can reach it. Set one with: apikey <secret>");
      apiKeyWarned = true;
    }
    return true;
  }
  String k = server.hasArg("key") ? server.arg("key") : "";
  if (k != apiKey) {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(401, "application/json", "{\"error\":\"unauthorized\"}");
    return false;
  }
  return true;
}

void webRoot() {
  String page = String(PAGE_HTML);
  page.replace("%DEVICE_NAME%", gFriendlyName + " - " + gBtName);
  server.send(200, "text/html", page);
}

void webStatus() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (!checkAuth()) return;
  server.send(200, "application/json", buildJson());
}

void webCmd() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (!checkAuth()) return;
  String c = server.hasArg("c") ? server.arg("c") : "";
  String r = handleCommand(c, "WEB");
  r.replace('\n', ' '); r.replace('\r', ' '); r.replace('"', '\'');
  String j = buildJson();
  j.remove(j.length() - 1);
  j += ",\"reply\":\"" + r + "\"}";
  server.send(200, "application/json", j);
}

// ==========================================================================
// WIFI SCAN  (GET /api/wifiscan  and the "wifiscan" command)
// --------------------------------------------------------------------------
// Returns {"scan":[{"ssid":"..","rssi":-55,"ch":6,"enc":3,"open":0},...],"count":N}
// so the mobile app can show nearby networks to pick from. scanNetworks() is
// blocking (~2-4 s) - fine for a user-triggered scan.
// ==========================================================================
// Turns the current scan results (n networks) into the JSON the app expects.
String scanResultJson(int n) {
  String s = "{\"scan\":[";
  const int cap = 24;                    // keep the payload small for the BT line
  int limit = n < cap ? n : cap;
  for (int i = 0; i < limit; i++) {
    if (i) s += ",";
    wifi_auth_mode_t enc = WiFi.encryptionType(i);
    s += "{\"ssid\":\"" + jsonEscape(WiFi.SSID(i)) + "\"";
    s += ",\"rssi\":" + String(WiFi.RSSI(i));
    s += ",\"ch\":"   + String(WiFi.channel(i));
    s += ",\"enc\":"  + String((int)enc);
    s += ",\"open\":" + String(enc == WIFI_AUTH_OPEN ? 1 : 0) + "}";
  }
  s += "],\"count\":" + String(n < 0 ? 0 : n) + "}";
  return s;
}

// WiFi mode used everywhere: STA only, or STA + hotspot.
wifi_mode_t wifiRunMode() { return USE_HOTSPOT ? WIFI_AP_STA : WIFI_STA; }

// ---- NON-BLOCKING SCAN for Bluetooth / Serial --------------------------------
// "wifiscan" over Bluetooth starts a background scan and the board keeps
// running (Bluetooth stays connected). When the scan finishes, the result
// JSON is sent as the next line on the same channel. The 1-second status
// line is paused meanwhile, so the next line the app reads IS the scan list.
// If the live scan fails, the last good list (cache) is sent instead.
#define SCAN_TIMEOUT_MS 8000
#define SCAN_MAX_TRIES  3
bool     scanRunning  = false;
uint8_t  scanTries    = 0;
uint8_t  scanReplyTo  = 0;      // 0 = nobody (boot/cache), 1 = Serial, 2 = Bluetooth
uint32_t scanStartedAt = 0;
uint32_t scanRetryAt  = 0;

bool scanKick() {
  WiFi.scanDelete();
  int r = WiFi.scanNetworks(true /*async*/, true /*show_hidden*/);
  scanTries++;
  scanStartedAt = millis();
  if (r == WIFI_SCAN_FAILED) { scanRetryAt = millis() + 400; return false; }
  scanRetryAt = 0;
  return true;
}

void startAsyncScan(uint8_t replyTo) {
  if (replyTo) scanReplyTo = replyTo;
  if (scanRunning) return;                 // already scanning - same reply
  scanRunning = true;
  scanTries = 0;
  // A scan fails while the station is mid-connect; stop that attempt first.
  if (WiFi.status() != WL_CONNECTED && staSsid.length()) WiFi.disconnect(false, false);
  Serial.println("[SCAN ] background WiFi scan started");
  scanKick();
}

void scanTick() {
  if (!scanRunning) return;
  if (scanRetryAt) {                       // last start failed - retry shortly
    if ((int32_t)(millis() - scanRetryAt) < 0) return;
    if (scanTries < SCAN_MAX_TRIES) { scanKick(); return; }
  } else {
    int n = WiFi.scanComplete();
    if (n == WIFI_SCAN_RUNNING && millis() - scanStartedAt < SCAN_TIMEOUT_MS) return;
    if (n > 0) {
      gScanCache = scanResultJson(n);
      Serial.printf("[SCAN ] %d networks found (try %u)\n", n, scanTries);
    } else if (scanTries < SCAN_MAX_TRIES) {
      Serial.printf("[SCAN ] try %u failed (%d) - retrying\n", scanTries, n);
      scanKick();
      return;
    }
  }
  // done (success, or out of tries)
  String s = gScanCache.length() ? gScanCache : String("{\"scan\":[],\"count\":0}");
  if (!gScanCache.length()) Serial.println("[SCAN ] no networks found");
  WiFi.scanDelete();
  scanRunning = false;
  scanRetryAt = 0;
  tWiFi = millis();                        // router reconnect resumes after the scan
  if (scanReplyTo == 1) Serial.println(s);
#if USE_BT
  if (scanReplyTo == 2 && SerialBT.hasClient()) SerialBT.println(s);
#endif
  scanReplyTo = 0;
}

// Blocking scan - used only by the web endpoint /api/wifiscan.
String buildWifiScanJson(bool suspendBt) {
  // A scan fails (-2) while BT Classic holds the shared radio. Over WiFi we can
  // pause BT for the scan; over Bluetooth we must not (it's the reply channel).
#if USE_BT
  // Never drop a phone that is connected over Bluetooth.
  if (suspendBt && SerialBT.hasClient()) suspendBt = false;
  if (suspendBt) { SerialBT.end(); delay(80); }
#endif
  // Stop any in-flight STA (re)connect - scanNetworks() returns -2 while the
  // driver is mid-connect. The reconnect is restarted after the scan.
  WiFi.mode(wifiRunMode());
  if (WiFi.status() != WL_CONNECTED) WiFi.disconnect(false /*wifioff*/, false /*eraseap*/);
  delay(150);
  int n = 0;
  // Over Bluetooth the scan usually fails, so try fewer times and fall back
  // to the cached list instead of blocking the board for ~15 s.
  uint8_t attempts = suspendBt ? 5 : 2;
#if !USE_BT
  attempts = 5;
#endif
  for (uint8_t attempt = 1; attempt <= attempts; attempt++) {   // AP+STA scan can be flaky
    WiFi.scanDelete();
    n = WiFi.scanNetworks(false /*async*/, true /*show_hidden*/);
    Serial.printf("[SCAN ] attempt %u -> %d networks%s\n", attempt, n,
                  suspendBt ? " (BT paused)" : "");
    if (n > 0) break;
    delay(400);
  }
  String s;
  if (n > 0) {
    s = scanResultJson(n);
    gScanCache = s;                        // remember the good list
  } else if (gScanCache.length()) {
    s = gScanCache;                        // live scan failed - send last good list
    Serial.println("[SCAN ] live scan failed - sending cached list");
  } else {
    s = "{\"scan\":[],\"count\":0}";
  }
  WiFi.scanDelete();
  tWiFi = millis();                      // loop() reconnects if needed
#if USE_BT
  if (suspendBt) SerialBT.begin(gBtName.c_str());   // bring Bluetooth back
#endif
  return s;
}

void webWifiScan() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (!checkAuth()) return;
  server.send(200, "application/json", buildWifiScanJson(true));
}

void startWiFi() {
  WiFi.persistent(false);          // settings come from Preferences, not WiFi NVS
  WiFi.mode(wifiRunMode());
  // NOTE: WiFi modem sleep must stay ON (default) while Bluetooth is used -
  // WiFi.setSleep(false) with Bluetooth on makes the Bluetooth link drop.
  WiFi.setAutoReconnect(false);    // loop() handles reconnects with back-off
#if USE_HOTSPOT
  bool apOk = WiFi.softAP(gApSsid.c_str(), AP_PASS);
  Serial.printf("[WIFI ] hotspot %s : %s / %s IP %s\n", apOk ? "OK" : "FAILED",
                gApSsid.c_str(), AP_PASS, WiFi.softAPIP().toString().c_str());
#else
  Serial.println("[WIFI ] hotspot OFF - set WiFi from the app over Bluetooth");
#endif

  if (staSsid.length()) {
    WiFi.begin(staSsid.c_str(), staPass.c_str());
    Serial.printf("[WIFI ] connecting to %s ", staSsid.c_str());
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 12000) { delay(400); Serial.print("."); }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED)
      Serial.printf("[WIFI ] connected IP %s\n", WiFi.localIP().toString().c_str());
    else
      Serial.println("[WIFI ] not connected yet - will keep retrying; or set new WiFi from the app");
    wifiAttemptAt = millis();
  } else {
    Serial.println("[WIFI ] no WiFi saved - connect the app over Bluetooth and pick your WiFi");
    startAsyncScan(0);             // fill the scan list now, before the phone asks
  }
  tWiFi = millis();

  if (MDNS.begin(MDNS_NAME))
    Serial.printf("[WIFI ] dashboard also at http://%s.local/\n", MDNS_NAME);

  server.on("/", webRoot);
  server.on("/api/status", webStatus);
  server.on("/api/cmd", webCmd);
  server.on("/api/wifiscan", webWifiScan);
  otaSetupWeb();
  server.onNotFound([]() { server.send(404, "text/plain", "not found"); });
  server.begin();
  Serial.println("[WIFI ] web server started on port 80");

  if (apiKey.length() == 0)
    Serial.println("[WARN ] No API key set yet. Before you port-forward this device, run: apikey <secret>");
}
#endif

// ==========================================================================
// CLOUD TELEMETRY  (online web app / admin portal)
// --------------------------------------------------------------------------
// Once the heater is joined to a router (STA) with internet, it registers
// itself with CLOUD_SERVER_URL once (POST /api/devices), stores the id + key
// the server returns, then POSTs a telemetry frame every ~15 s
// (POST /api/devices/{id}/telemetry). Commands: cloud on | cloud off | cloud
// | cloudkey <key> | cloudreg. HTTP calls block for up to a few seconds.
// ==========================================================================
#if USE_CLOUD
WiFiClient       cloudPlainClient;
WiFiClientSecure cloudSecureClient;

static const char* cloudLevelName[4] = { "off", "low", "medium", "high" };

const char* cloudFaultName(uint8_t f) {
  switch (f) {
    case FLT_OVERCURRENT: return "over_current";
    case FLT_NOLOAD:      return "no_load";
    case FLT_OVERTEMP:    return "over_temperature";
    default:              return "ok";
  }
}

// Number, or JSON null when the sensor isn't present (-127 sentinel).
String cloudNum(float v, unsigned int decimals = 1) {
  if (isnan(v) || v <= -50) return "null";
  return String(v, decimals);
}

String cloudMask(const String& s) {
  if (s.length() <= 6) return s.length() ? "******" : "(none)";
  return s.substring(0, 3) + "..." + s.substring(s.length() - 3);
}

String cloudHost() {
  String h = cloudBaseUrl;
  int s = h.indexOf("://"); if (s >= 0) h = h.substring(s + 3);
  int slash = h.indexOf('/'); if (slash >= 0) h = h.substring(0, slash);
  int colon = h.indexOf(':'); if (colon >= 0) h = h.substring(0, colon);
  return h;
}

String cloudJsonString(const String& src, const String& key) {
  int k = src.indexOf("\"" + key + "\"");
  if (k < 0) return "";
  int c = src.indexOf(':', k);
  if (c < 0) return "";
  int q1 = src.indexOf('"', c + 1);
  if (q1 < 0) return "";
  int q2 = src.indexOf('"', q1 + 1);
  if (q2 < 0) return "";
  return src.substring(q1 + 1, q2);
}

long cloudJsonNumber(const String& src, const String& key) {
  int k = src.indexOf("\"" + key + "\"");
  if (k < 0) return -1;
  int c = src.indexOf(':', k);
  if (c < 0) return -1;
  return src.substring(c + 1).toInt();
}

void saveCloud() {
  prefs.begin("heater", false);
  prefs.putBool("cloud_en", cloudEnabled);
  prefs.putString("cloud_pk", cloudProvKey);
  prefs.putString("cloud_did", cloudDeviceId);
  prefs.putString("cloud_dk", cloudDeviceKey);
  prefs.end();
}

bool cloudBegin(HTTPClient& http, const String& url) {
  if (url.startsWith("https")) {
    http.setConnectTimeout(5000);
    http.setTimeout(9000);
    cloudSecureClient.setInsecure();          // no certificate check
    return http.begin(cloudSecureClient, url);
  }
  http.setConnectTimeout(2500);
  http.setTimeout(3000);
  return http.begin(cloudPlainClient, url);
}

String buildCloudTelemetry() {
  bool btClient = false;
#if USE_BT
  btClient = SerialBT.hasClient();
#endif
  bool staUp = (WiFi.status() == WL_CONNECTED);

  String s = "{";
  s += "\"level\":\"" + String(cloudLevelName[heatLevel]) + "\"";
  s += ",\"levelValue\":" + String(heatLevel);
  s += ",\"manual\":" + String(manualMode ? "true" : "false");
  s += ",\"autoFan\":" + String(autoFan ? "true" : "false");
  s += ",\"tripped\":" + String(systemTrip ? "true" : "false");
  s += ",\"climate\":" + String(climateMode ? "true" : "false");
  s += ",\"climateTargetC\":" + String(targetTemp, 1);
  s += ",\"totalCurrentA\":" + String(totalCurrent, 2);
  s += ",\"sumCurrentA\":" + String(sumCurrent, 2);
  s += ",\"totalPowerW\":" + String(totalPower, 1);
  s += ",\"readingSource\":\"" + String(overallSrc[0] == 'M' ? "meter" : "ct") + "\"";
  s += ",\"mainsVoltageV\":" + String(mainsV, 0);
  if (meterVoltage > 0) {
    s += ",\"meterVoltageV\":" + String(meterVoltage, 1);
    s += ",\"meterCurrentA\":" + String(meterCurrent, 2);
    s += ",\"meterPowerW\":" + String(meterPower, 1);
    s += ",\"meterEnergyWh\":" + String(meterEnergy, 2);
    s += ",\"meterFrequencyHz\":" + String(meterFreq, 1);
  }
  s += ",\"temp1C\":" + cloudNum(tempC[0]);
  s += ",\"temp2C\":null";                     // this board has one DS18B20
  s += ",\"dhtTempC\":null";                   // no DHT22 on this board
  s += ",\"maxTempC\":" + cloudNum(maxTemp);
  s += ",\"humidity1Pct\":null";
  s += ",\"currentLimitA\":" + String(iLimit, 1);
  s += ",\"totalLimitA\":" + String(tLimit, 1);
  s += ",\"temperatureLimitC\":" + String(tempLimit, 0);
  s += ",\"wifi\":\"" + String(staUp ? "STA" : "AP") + "\"";
  s += ",\"ip\":\"" + (staUp ? WiFi.localIP().toString() : WiFi.softAPIP().toString()) + "\"";
  s += ",\"bluetoothClient\":" + String(btClient ? "true" : "false");
  s += ",\"apiKeySet\":" + String(apiKey.length() ? "true" : "false");
  s += ",\"uptimeSeconds\":" + String(millis() / 1000);
  s += ",\"rssi\":" + String(staUp ? WiFi.RSSI() : 0);
  s += ",\"channels\":[";
  for (uint8_t i = 0; i < DEV_COUNT; i++) {
    if (i) s += ",";
    s += "{\"channelIndex\":" + String(i);
    s += ",\"channelId\":\"" + String(devKey[i]) + "\"";
    s += ",\"isOn\":" + String(relayActual[i] ? "true" : "false");
    s += ",\"voltageV\":" + String(devVolt(i), 1);
    s += ",\"currentA\":" + String(current[i], 2);
    s += ",\"powerW\":" + String(devVolt(i) * current[i], 1);
    s += ",\"energyWh\":" + String((float)energyWh[i], 1);
    s += ",\"fault\":\"" + String(cloudFaultName(devFault[i])) + "\"}";
  }
  s += "]}";
  return s;
}

bool cloudRegister() {
  if (cloudBaseUrl.isEmpty()) { cloudLastError = "no server URL set"; return false; }
  String url = cloudBaseUrl + "/api/devices";
  HTTPClient http;
  if (!cloudBegin(http, url)) { cloudLastError = "bad URL"; return false; }
  http.addHeader("Content-Type", "application/json");
  if (strlen(CLOUD_ADMIN_KEY)) http.addHeader("X-Admin-Key", CLOUD_ADMIN_KEY);
  if (cloudProvKey.length())   http.addHeader("X-Provisioning-Key", cloudProvKey);

  String body = "{";
  body += "\"name\":\"" + jsonEscape(gFriendlyName) + "\"";
  body += ",\"serialNumber\":\"HTR-VER1-" + gDeviceId + "\"";
  body += ",\"firmwareVersion\":\"" FW_VERSION "\"";
  body += ",\"updateAvailable\":\"" + otaAvailVer + "\"";
  body += ",\"otaState\":\"" + otaState + "\"";
  body += ",\"model\":\"HEATER Ver1\"";
  body += ",\"bluetoothName\":\"" + jsonEscape(gBtName) + "\"";
  if (staSsid.length()) body += ",\"homeSsid\":\"" + jsonEscape(staSsid) + "\"";
  body += ",\"localAddress\":\"http://" + WiFi.localIP().toString() + "\"";
  body += "}";

  Serial.println("[CLOUD] ---- REGISTER ----");
  Serial.println("[CLOUD] POST " + url);
  Serial.println("[CLOUD] body: " + body);

  uint32_t t0 = millis();
  int code = http.POST(body);
  uint32_t dt = millis() - t0;
  String resp = http.getString();
  http.end();

  Serial.printf("[CLOUD] <- HTTP %d in %lu ms\n", code, (unsigned long)dt);
  Serial.println("[CLOUD] resp: " + (resp.length() ? resp : String("(empty)")));

  if (code == 200 || code == 201) {
    String id  = cloudJsonString(resp, "id");
    String key = cloudJsonString(resp, "deviceKey");
    if (id.length() && key.length()) {
      cloudDeviceId = id; cloudDeviceKey = key; saveCloud();
      cloudLastError = "";
      Serial.println("[CLOUD] SUCCESS registered id=" + cloudDeviceId +
                     " key=" + cloudMask(cloudDeviceKey));
      return true;
    }
    cloudLastError = "register: no id/key in reply";
  } else {
    cloudLastError = "register HTTP " + String(code);
  }
  Serial.println("[CLOUD] REGISTER FAILED: " + cloudLastError);
  return false;
}

bool cloudPostTelemetry() {
  String url = cloudBaseUrl + "/api/devices/" + cloudDeviceId + "/telemetry";
  HTTPClient http;
  if (!cloudBegin(http, url)) { cloudLastError = "bad URL"; return false; }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", cloudDeviceKey);
  if (strlen(CLOUD_ADMIN_KEY)) http.addHeader("X-Admin-Key", CLOUD_ADMIN_KEY);

  String body = buildCloudTelemetry();
  Serial.println("[CLOUD] POST " + url + "  (" + String(body.length()) + " bytes)");

  uint32_t t0 = millis();
  int code = http.POST(body);
  uint32_t dt = millis() - t0;
  String resp = http.getString();
  http.end();

  Serial.printf("[CLOUD] <- HTTP %d in %lu ms\n", code, (unsigned long)dt);

  if (code == 200) {
    long iv = cloudJsonNumber(resp, "nextIntervalMs");
    if (iv >= 1000 && iv <= 3600000) cloudIntervalMs = (uint32_t)iv;
    cloudLastError = "";
    Serial.printf("[CLOUD] SUCCESS telemetry accepted, next in %lu s\n",
                  (unsigned long)(cloudIntervalMs / 1000));
    return true;
  }
  if (code == 401 || code == 403 || code == 404) {
    // Key rejected or device deleted on the server: re-register.
    cloudDeviceId = ""; cloudDeviceKey = ""; saveCloud();
    cloudLastError = "auth " + String(code) + ", will re-register";
  } else {
    cloudLastError = "telemetry HTTP " + String(code);
    Serial.println("[CLOUD] resp: " + (resp.length() ? resp : String("(empty)")));
  }
  Serial.println("[CLOUD] TELEMETRY FAILED: " + cloudLastError);
  return false;
}

void cloudTick() {
  if (!cloudEnabled) return;
  if (cloudBaseUrl.isEmpty()) return;
  if (millis() - tCloud < cloudIntervalMs) return;
  if (cloudHoldUntil && (int32_t)(millis() - cloudHoldUntil) < 0) return;   // back-off after failures
  cloudHoldUntil = 0;
  tCloud = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CLOUD] skip: not joined to a router yet - set WiFi from the app (wifi <ssid> <pass>)");
    return;
  }

#if USE_WIFI
  if (scanRunning) return;                 // don't block during a WiFi scan
#endif
  Serial.printf("[CLOUD] server %s  ip %s  rssi %d dBm  heap %u\n",
                cloudBaseUrl.c_str(), WiFi.localIP().toString().c_str(),
                (int)WiFi.RSSI(), (unsigned)ESP.getFreeHeap());

  bool ok;
  if (cloudDeviceId.isEmpty() || cloudDeviceKey.isEmpty()) ok = cloudRegister();
  else ok = cloudPostTelemetry();

  // Server down / unreachable: wait longer between tries (up to 2 min), so
  // the board isn't repeatedly frozen by HTTP timeouts.
  static uint8_t fails = 0;
  if (ok) fails = 0; else if (fails < 3) fails++;
  if (fails) {
    uint32_t wait = 15000UL << fails;      // 30 s, 60 s, 120 s
    cloudHoldUntil = millis() + wait;
    Serial.printf("[CLOUD] server not reachable - next try in %lu s\n", (unsigned long)(wait / 1000));
  }
}

// ==========================================================================
// OTA - WIRELESS FIRMWARE UPDATE
// ==========================================================================
// "1.10.2" > "1.9.9"
int otaCompare(const String& a, const String& b) {
  int ia = 0, ib = 0;
  for (int part = 0; part < 4; part++) {
    long va = 0, vb = 0;
    while (ia < (int)a.length() && isdigit(a[ia])) va = va * 10 + (a[ia++] - '0');
    while (ib < (int)b.length() && isdigit(b[ib])) vb = vb * 10 + (b[ib++] - '0');
    if (va != vb) return va < vb ? -1 : 1;
    if (ia < (int)a.length()) ia++;
    if (ib < (int)b.length()) ib++;
  }
  return 0;
}

bool otaCheck() {
  if (WiFi.status() != WL_CONNECTED) { otaState = "failed: no WiFi"; return false; }
  if (cloudBaseUrl.isEmpty())         { otaState = "failed: no server set"; return false; }
  otaLastCheck = millis();
  otaState = "checking";
  String url = cloudBaseUrl + "/api/firmware/latest?model=" OTA_MODEL "&current=" FW_VERSION "&device=" + gDeviceId;
  HTTPClient http;
  if (!cloudBegin(http, url)) { otaState = "failed: bad server URL"; return false; }
  if (cloudDeviceKey.length()) http.addHeader("X-Device-Key", cloudDeviceKey);
  int code = http.GET();
  String resp = code == 200 ? http.getString() : "";
  http.end();
  if (code == 204 || code == 404) { otaAvailVer = ""; otaState = "up-to-date"; Serial.println("[OTA  ] no update on server"); return true; }
  if (code != 200) { otaState = "failed: server HTTP " + String(code); Serial.println("[OTA  ] check " + otaState); return false; }
  String ver = cloudJsonString(resp, "version");
  if (ver.isEmpty() || otaCompare(ver, FW_VERSION) <= 0) {
    otaAvailVer = ""; otaState = "up-to-date";
    Serial.printf("[OTA  ] up to date (server %s, running %s)\n", ver.c_str(), FW_VERSION);
    return true;
  }
  otaAvailVer   = ver;
  otaAvailUrl   = cloudJsonString(resp, "url");
  otaAvailMd5   = cloudJsonString(resp, "md5");
  otaAvailNotes = cloudJsonString(resp, "notes");
  long sz = cloudJsonNumber(resp, "size"); otaAvailSize = sz > 0 ? (uint32_t)sz : 0;
  if (otaAvailUrl.startsWith("/")) otaAvailUrl = cloudBaseUrl + otaAvailUrl;   // relative link
  otaState = "available";
  Serial.printf("[OTA  ] UPDATE AVAILABLE %s -> %s  (%s)\n", FW_VERSION, ver.c_str(), otaAvailNotes.c_str());
  beep(2);
  return true;
}

// Download + flash. Blocks for the download (heaters are OFF). Returns only on failure.
void otaInstall(const String& url, const String& md5, uint32_t expectSize) {
  if (WiFi.status() != WL_CONNECTED) { otaState = "failed: no WiFi"; return; }
  allOff("firmware update");
  for (uint8_t i = 0; i < DEV_COUNT; i++) { relayActual[i] = false; digitalWrite(relayPin[i], RELAY_OFF); }
  climateMode = false; measPhase = 0;
  otaState = "downloading"; otaPct = 0;
  Serial.println("[OTA  ] all outputs OFF - downloading " + url);

  HTTPClient http;
  if (!cloudBegin(http, url)) { otaState = "failed: bad file URL"; return; }
  http.setTimeout(15000);
  if (cloudDeviceKey.length()) http.addHeader("X-Device-Key", cloudDeviceKey);
  int code = http.GET();
  if (code != 200) { otaState = "failed: download HTTP " + String(code); http.end(); Serial.println("[OTA  ] " + otaState); return; }
  int len = http.getSize();
  if (len <= 0 && expectSize) len = expectSize;
  if (len <= 0) { otaState = "failed: unknown file size"; http.end(); return; }
  if (expectSize && (uint32_t)len != expectSize) { otaState = "failed: size mismatch"; http.end(); return; }
  if (!Update.begin(len, U_FLASH)) {
    otaState = "failed: file too big for OTA slot (" + String(len) + " B)";
    http.end(); Serial.println("[OTA  ] " + otaState); return;
  }
  if (md5.length() == 32) Update.setMD5(md5.c_str());

  WiFiClient* st = http.getStreamPtr();
  uint8_t buf[1024];
  int done = 0; uint32_t lastData = millis();
  while (done < len) {
    size_t avail = st->available();
    if (avail) {
      int n = st->readBytes(buf, min((size_t)sizeof(buf), avail));
      if (Update.write(buf, n) != (size_t)n) break;
      done += n; lastData = millis();
      uint8_t pct = (uint8_t)((uint64_t)done * 100 / len);
      if (pct != otaPct) {
        otaPct = pct;
        if (pct % 10 == 0) Serial.printf("[OTA  ] %u %%\n", pct);
#if USE_BT
        if (pct % 10 == 0 && SerialBT.hasClient()) SerialBT.printf("{\"otaState\":\"downloading\",\"otaPct\":%u}\n", pct);
#endif
      }
    } else {
      if (millis() - lastData > 20000) break;      // stalled
      delay(2);
    }
  }
  http.end();
  if (done != len) { Update.abort(); otaState = "failed: download interrupted"; Serial.println("[OTA  ] " + otaState + " - old firmware kept"); return; }
  if (!Update.end(true)) {
    otaState = String("failed: verify (") + Update.errorString() + ")";
    Serial.println("[OTA  ] " + otaState + " - old firmware kept");
    return;
  }
  otaState = "done"; otaPct = 100;
  Serial.println("[OTA  ] SUCCESS - new firmware verified, restarting...");
#if USE_BT
  if (SerialBT.hasClient()) SerialBT.println("{\"otaState\":\"done\",\"otaPct\":100}");
#endif
  delay(800);
  ESP.restart();
}

String otaCommand(const String& lc, const String& cmd) {
  if (lc == "ota") {
    String r = "FW " FW_VERSION " | OTA: " + otaState;
    if (otaState == "downloading") r += " " + String(otaPct) + "%";
    if (otaAvailVer.length()) r += " | update available: " + otaAvailVer + (otaAvailNotes.length() ? " (" + otaAvailNotes + ")" : "");
    const esp_partition_t* run = esp_ota_get_running_partition();
    if (run) r += " | slot " + String(run->label);
    return r;
  }
  if (lc == "ota check") {
    otaCheck();
    return otaAvailVer.length() ? "UPDATE AVAILABLE: " + otaAvailVer + " - send 'ota install'" : "OTA: " + otaState;
  }
  if (lc == "ota install") {
    if (otaAvailVer.isEmpty()) { otaCheck(); }
    if (otaAvailVer.isEmpty()) return "No update available (" + otaState + ")";
    otaInstallReq = true;
    return "Installing " + otaAvailVer + " - all outputs OFF, board restarts when done";
  }
  if (lc.startsWith("ota url ")) {
    String u = cmd.substring(8); u.trim();
    if (!u.startsWith("http")) return "usage: ota url http://server/file.bin";
    otaAvailVer = "manual"; otaAvailUrl = u; otaAvailMd5 = ""; otaAvailSize = 0;
    otaInstallReq = true;
    return "Installing from " + u;
  }
  return "usage: ota | ota check | ota install | ota url <link>";
}

void otaTick() {
  // New firmware ran 30 s without crashing -> keep it (cancels rollback if enabled).
  if (!otaMarkedValid && millis() > 30000) { esp_ota_mark_app_valid_cancel_rollback(); otaMarkedValid = true; }
  if (otaInstallReq) {
    otaInstallReq = false;
    otaInstall(otaAvailUrl, otaAvailMd5, otaAvailSize);   // returns only on failure
    return;
  }
  if (WiFi.status() != WL_CONNECTED || !cloudEnabled) return;
  uint32_t due = otaLastCheck ? OTA_CHECK_MS : OTA_FIRST_CHECK_MS;
  if (millis() - otaLastCheck > due && otaState != "downloading") otaCheck();
}
#endif  // USE_CLOUD

// ---- Local upload: app / browser POSTs the .bin straight to the board ----
// POST http://<board-ip>/api/ota?key=<apikey>   (multipart form, field "firmware")
bool otaUploadOk = false;
void otaSetupWeb() {
  server.on("/api/ota", HTTP_POST,
    []() {                                     // finished
      server.sendHeader("Access-Control-Allow-Origin", "*");
      if (!otaUploadOk || Update.hasError()) {
        server.send(500, "application/json", "{\"ok\":false,\"otaState\":\"" + otaState + "\"}");
        return;
      }
      server.send(200, "application/json", "{\"ok\":true,\"otaState\":\"done\",\"msg\":\"restarting on new firmware\"}");
      delay(800);
      ESP.restart();
    },
    []() {                                     // receiving the file
      HTTPUpload& up = server.upload();
      if (up.status == UPLOAD_FILE_START) {
        otaUploadOk = false;
        if (apiKey.length() && server.arg("key") != apiKey) { otaState = "failed: wrong key"; return; }
        allOff("firmware update (upload)");
        for (uint8_t i = 0; i < DEV_COUNT; i++) { relayActual[i] = false; digitalWrite(relayPin[i], RELAY_OFF); }
        climateMode = false; measPhase = 0;
        otaState = "downloading"; otaPct = 0;
        Serial.printf("[OTA  ] upload started: %s\n", up.filename.c_str());
        if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) otaState = "failed: no OTA slot - check partition scheme";
      } else if (up.status == UPLOAD_FILE_WRITE) {
        if (otaState != "downloading") return;
        if (Update.write(up.buf, up.currentSize) != up.currentSize) otaState = "failed: write";
        else if (up.totalSize % (64 * 1024) < up.currentSize) Serial.printf("[OTA  ] %u KB\n", (unsigned)(up.totalSize / 1024));
      } else if (up.status == UPLOAD_FILE_END) {
        if (otaState != "downloading") { Update.abort(); return; }
        if (Update.end(true)) { otaUploadOk = true; otaState = "done"; otaPct = 100;
                                Serial.printf("[OTA  ] upload OK %u bytes - restarting\n", (unsigned)up.totalSize); }
        else { otaState = String("failed: verify (") + Update.errorString() + ")"; Serial.println("[OTA  ] " + otaState + " - old firmware kept"); }
      } else if (up.status == UPLOAD_FILE_ABORTED) {
        Update.abort(); otaState = "failed: upload aborted"; Serial.println("[OTA  ] upload aborted - old firmware kept");
      }
    });
}

// ==========================================================================
// SETUP
// ==========================================================================
void setup() {
  // ---- outputs first, everything OFF -----------------------------------
  for (uint8_t i = 0; i < DEV_COUNT; i++) {
    pinMode(relayPin[i], OUTPUT);
    digitalWrite(relayPin[i], RELAY_OFF);
  }
  const uint8_t inds[4] = { IND_LOW, IND_MED, IND_HIGH, IND_STATUS };
  for (uint8_t i = 0; i < 4; i++) { pinMode(inds[i], OUTPUT); digitalWrite(inds[i], LED_OFF); }
  pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);

  Serial.begin(115200);
  delay(300);
  Serial.println("\n\n=================================================");
  Serial.printf (" %s - ESP32-WROOM-32 CONTROLLER\n", DEVICE_NAME);
  Serial.println(" 4 Heater / Fan / Light + 6 CT + IR/BT/WiFi + API Key");
  Serial.println("=================================================");

  loadSettings();

  // Unique id from the chip's factory MAC, reported as "devid" so the app
  // can tell boards apart even if two share the same DEVICE_NAME.
  {
    uint64_t chip = ESP.getEfuseMac();
    char suffix[7];
    snprintf(suffix, sizeof(suffix), "%02X%02X%02X",
             (uint8_t)((chip >> 24) & 0xFF), (uint8_t)((chip >> 32) & 0xFF),
             (uint8_t)((chip >> 40) & 0xFF));   // last 3 MAC bytes = unique per chip
             // (the first 3 bytes are the Espressif maker code - same on every board)
    gDeviceId = String(suffix);
    gBtName = String(BT_NAME) + "_" + gDeviceId;
    gFriendlyName = String(FRIENDLY_NAME) + "_" + gDeviceId;   // e.g. asvrl_A1B2C3
    gApSsid = String(AP_SSID) + "_" + gDeviceId;
    Serial.printf("[INFO ] Device ID %s   NAME \"%s\"   BT \"%s\"   AP \"%s\"\n",
                  gDeviceId.c_str(), gFriendlyName.c_str(), gBtName.c_str(), gApSsid.c_str());
  }

  // ---- ADC --------------------------------------------------------------
  analogReadResolution(12);
  for (uint8_t i = 0; i < DEV_COUNT; i++)
    analogSetPinAttenuation(ctPin[i], ADC_11db);

#if USE_TEMP
  ds1.begin();
  ds1.setWaitForConversion(false);
  Serial.printf("[TEMP ] sensors found: %d\n", ds1.getDeviceCount());
  if (ds1.getDeviceCount() == 0)
    Serial.println("[TEMP ] WARNING: no DS18B20 detected on GPIO21 at boot - check wiring / 4.7k pull-up resistor between DQ and 3.3V");
#endif

#if USE_DISPLAY
  tm1637.setBrightness(7);
  const uint8_t blank[] = { 0, 0, 0, 0 };
  tm1637.setSegments(blank);
  Serial.println("[DISP ] TM1637 display ready (CLK=22 DIO=23)");
#endif

#if USE_IR
  IrReceiver.begin(IR_PIN, DISABLE_LED_FEEDBACK);
  Serial.println("[IR ] VS1838B ready. Map keys with: irlearn <0-8>");
#endif

#if USE_BT
  // Same order and name as the reference firmware: Bluetooth first, then WiFi.
  SerialBT.begin(gBtName.c_str());
  Serial.printf("[BT ] Bluetooth SPP ready. Pair with \"%s\"\n", gBtName.c_str());
#endif

#if USE_ENERGY_METER
  Serial2.begin(9600, SERIAL_8N1, 16, 17);
  Serial.println("[METER] UART energy meter enabled on GPIO16/17");
#endif

#if USE_WIFI
  startWiFi();
#endif

  tEnergy = millis();
  // SAFE START: whole system OFF after every power-up / unplug. Nothing is
  // restored from before the power cut - heaters, fan, light, auto-comfort,
  // self-test all stay OFF until a person turns them on (app / IR / command).
  allOff("power-up safe start");
  for (uint8_t i = 0; i < DEV_COUNT; i++) {
    relayActual[i] = false;
    digitalWrite(relayPin[i], RELAY_OFF);
  }
  Serial.println("[BOOT ] SAFE START - WHOLE SYSTEM OFF: heaters 1-4, fan, light, auto-comfort.");
  {
    const esp_partition_t* run = esp_ota_get_running_partition();
    const esp_partition_t* nxt = esp_ota_get_next_update_partition(NULL);
    Serial.printf("[BOOT ] FW %s running from slot %s - wireless update %s\n", FW_VERSION,
                  run ? run->label : "?", nxt ? "READY" : "NOT POSSIBLE (set Partition Scheme to 'No FS 4MB (2MB APP x2)')");
  }
  Serial.println("[BOOT ] Nothing runs until you turn it on from the app, IR remote or a command.");
  Serial.printf("[INFO ] %s ready. Saved target %.1f C (send 'climate on' to use it). Send 'help' for commands.\n\n", DEVICE_NAME, targetTemp);
  beep(2);
}

// ==========================================================================
// LOOP
// ==========================================================================
void loop() {
  // ---- Serial input -----------------------------------------------------
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (serialBuf.length()) {
        String r = handleCommand(serialBuf, "SER");
        if (r.length()) Serial.println(r);
        serialBuf = "";
      }
    } else if (serialBuf.length() < 120) serialBuf += ch;
  }

  // ---- Bluetooth input --------------------------------------------------
#if USE_BT
  while (SerialBT.available()) {
    char ch = SerialBT.read();
    if (ch == '\n' || ch == '\r') {
      if (btBuf.length()) {
        String r = handleCommand(btBuf, "BT ");
        if (r.length()) SerialBT.println(r);
        btBuf = "";
      }
    } else if (btBuf.length() < 120) btBuf += ch;
  }
  static uint32_t tBt = 0;
  static bool btWas = false;
  bool btNow = SerialBT.hasClient();
  if (btNow != btWas) {
    btWas = btNow;
    Serial.println(btNow ? "[LOGIN] Bluetooth app CONNECTED" : "[LOGIN] Bluetooth app DISCONNECTED");
    if (btNow) btConnectedAt = millis();
  }
  // 1-second status line; paused while a Bluetooth WiFi scan is running so
  // the scan list is the next line the app receives.
  bool scanForBt = false;
#if USE_WIFI
  scanForBt = scanRunning && scanReplyTo == 2;
#endif
  if (btNow && !scanForBt && millis() - tBt > 1000) {
    tBt = millis();
    SerialBT.println(buildJson());
  }
#endif

#if USE_WIFI
  server.handleClient();
  // Apply newly saved credentials shortly after the command replied, so the
  // app gets its HTTP/BT response before WiFi.begin() reconfigures the radio.
  scanTick();
  if (wifiApplyPending && millis() >= wifiApplyAt && !scanRunning) {
    wifiApplyPending = false;
    tWiFi = millis();
    wifiAttemptAt = millis();
    wifiRetryMs = 15000;
    Serial.printf("[WIFI ] applying new credentials, connecting to %s\n", staSsid.c_str());
    WiFi.disconnect();          // clear any pending connect so the new config sticks
    delay(120);
    WiFi.begin(staSsid.c_str(), staPass.c_str());
  }
  // Auto-reconnect with back-off (15 s, 30 s, 60 s ... 5 min), so a wrong
  // password or a router that is off doesn't keep disturbing Bluetooth.
  // disconnect() first: WiFi.begin() while the STA is mid-connect fails.
  if (staSsid.length() && WiFi.status() != WL_CONNECTED && !scanRunning &&
      !wifiApplyPending && millis() - tWiFi > wifiRetryMs) {
    tWiFi = millis();
    wifiAttemptAt = millis();
    Serial.printf("[WIFI ] reconnecting to \"%s\" (next try in %lu s)...\n",
                  staSsid.c_str(), (unsigned long)(wifiRetryMs * 2 > 300000 ? 300 : wifiRetryMs * 2 / 1000));
    wifiRetryMs = wifiRetryMs * 2 > 300000 ? 300000 : wifiRetryMs * 2;
    WiFi.disconnect();
    delay(120);
    WiFi.begin(staSsid.c_str(), staPass.c_str());
  }
  // Log router link changes so app logins are visible on Serial.
  static wl_status_t wifiWas = WL_NO_SHIELD;
  wl_status_t wifiNow = WiFi.status();
  if (wifiNow != wifiWas) {
    if (wifiNow == WL_CONNECTED) {
      wifiConnectedAt = millis();
      Serial.printf("[LOGIN] WiFi STA CONNECTED to \"%s\" IP %s\n",
                    staSsid.c_str(), WiFi.localIP().toString().c_str());
      wifiRetryMs = 15000;
#if USE_CLOUD
      tCloud = millis() - cloudIntervalMs + 2000;   // report to the web app ~2 s after joining
      cloudHoldUntil = 0;
#endif
    }
    else if (wifiWas == WL_CONNECTED)
      Serial.println("[LOGIN] WiFi STA DISCONNECTED");
    wifiWas = wifiNow;
  }
#endif

#if USE_IR
  irTick();
#endif
#if USE_TEMP
  tempTick();
#endif
#if USE_DISPLAY
  displayTick();
#endif
#if USE_ENERGY_METER
  meterTick();
#endif

  ctTick();
  devicePowerTick();
  measureTick();
#if USE_CLOUD
  otaTick();
#endif
  energyTick();
  testTick();
  climateTick();
  safetyTick();
  relayTick();
  indicationTick();
#if USE_CLOUD
  cloudTick();   // register + send telemetry to the online web app
#endif
  buzzerTick();

  if (autoPrint && millis() - tPrint > PRINT_INTERVAL_MS) {
    tPrint = millis();
    printStatusTable();
  }
}
