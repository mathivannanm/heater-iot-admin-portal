#!/usr/bin/env node
/**
 * A fake TEMP-HUM Ver1 sensor board.
 *
 * Talks to the server exactly as the ESP32 firmware does: it registers once
 * with POST /api/devices, keeps the id and device key it is given, and then
 * posts a telemetry frame to POST /api/devices/{id}/telemetry on a timer. It
 * touches nothing but the HTTP API, so what it proves about the server holds
 * for the real board.
 *
 *   node scripts/simulate-temphum.mjs <server-url> <admin-key> [options]
 *
 *   node scripts/simulate-temphum.mjs http://localhost:3210 my-admin-key
 *   node scripts/simulate-temphum.mjs http://localhost:3210 my-admin-key --missing --count 10
 *
 * Options
 *   --serial <serial>          serial number to register   (default TH-VER1-SIM001)
 *   --name <name>              device name                 (default "Temp-Hum SIM001")
 *   --interval <seconds>       seconds between frames      (default 5)
 *   --count <n>                stop after n frames         (default: run until Ctrl-C)
 *   --missing                  send temp4C and humidity2Pct as null (sensor missing)
 *   --provisioning-key <key>   only if the server sets HEATER_PROVISIONING_KEY
 *
 * Running it again with the same serial re-registers the same device (its
 * history is kept) and is issued a fresh device key.
 */

const USAGE = "usage: node scripts/simulate-temphum.mjs <server-url> <admin-key> [--serial S] [--name N] [--interval SECONDS] [--count N] [--missing] [--provisioning-key K]";

function parseArgs(argv) {
  const positional = [];
  const options = { serial: "TH-VER1-SIM001", name: null, interval: 5, count: Infinity, missing: false, provisioningKey: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[(index += 1)];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "--serial": options.serial = value(); break;
      case "--name": options.name = value(); break;
      case "--interval": options.interval = Number(value()); break;
      case "--count": options.count = Number(value()); break;
      case "--provisioning-key": options.provisioningKey = value(); break;
      case "--missing": options.missing = true; break;
      case "-h":
      case "--help": console.log(USAGE); process.exit(0); break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
        positional.push(arg);
    }
  }

  if (positional.length < 2) throw new Error("the server URL and the admin key are required");
  if (!Number.isFinite(options.interval) || options.interval <= 0) throw new Error("--interval must be a positive number of seconds");
  if (Number.isNaN(options.count) || options.count < 1) throw new Error("--count must be 1 or more");

  const suffix = options.serial.split("-").pop();
  return {
    ...options,
    server: positional[0].replace(/\/+$/, ""),
    adminKey: positional[1],
    name: options.name ?? `Temp-Hum ${suffix}`,
    suffix,
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round1 = (value) => Math.round(value * 10) / 10;

/** A reading that drifts from frame to frame instead of jumping about. */
function walker(start, min, max, step) {
  let value = start;
  return () => {
    value = clamp(value + (Math.random() - 0.5) * 2 * step, min, max);
    return round1(value);
  };
}

async function call(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: the URL is probably not this server. The status says the rest.
  }
  return { status: response.status, ok: response.ok, json, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --- 1. register ------------------------------------------------------------
  const registration = await call(
    `${args.server}/api/devices`,
    {
      "X-Admin-Key": args.adminKey,
      ...(args.provisioningKey ? { "X-Provisioning-Key": args.provisioningKey } : {}),
    },
    {
      name: args.name,
      serialNumber: args.serial,
      firmwareVersion: "1.0.0",
      model: "TEMP-HUM Ver1",
      bluetoothName: `HEATER_VER1_TH_${args.suffix}`,
      homeSsid: "MyWiFi",
      localAddress: "http://192.168.1.50",
    },
  );

  const id = registration.json?.device?.id;
  const deviceKey = registration.json?.deviceKey;
  if (!registration.ok || !id || !deviceKey) {
    throw new Error(
      `registration failed: HTTP ${registration.status} ${registration.json?.error ?? registration.text.slice(0, 200)}`,
    );
  }

  console.log(`${registration.status === 201 ? "registered" : "re-registered"} ${args.name} (${args.serial})`);
  console.log(`  id         ${id}`);
  console.log(`  deviceKey  ${deviceKey}`);
  console.log(`  page       ${args.server}/sensors/${id}`);
  console.log(
    `posting every ${args.interval}s${args.missing ? ", with T4 and H2 missing" : ""}${Number.isFinite(args.count) ? `, ${args.count} frames` : " until Ctrl-C"}\n`,
  );

  // --- 2. telemetry -----------------------------------------------------------
  const temps = [
    walker(24.6, 20, 35, 0.3),
    walker(25.1, 20, 35, 0.3),
    walker(23.8, 20, 35, 0.3),
    walker(26.0, 20, 35, 0.3),
  ];
  const humidity = [walker(58.2, 40, 80, 0.8), walker(61.0, 40, 80, 0.8)];
  const dhtTemps = [walker(24.9, 20, 35, 0.2), walker(25.3, 20, 35, 0.2)];
  const rssi = walker(-58, -85, -45, 1.5);
  const bootedAt = Date.now();

  let sent = 0;
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\nstopping");
  });

  while (!stopping && sent < args.count) {
    const [temp1C, temp2C, temp3C, temp4] = temps.map((next) => next());
    const [humidity1Pct, humidity2] = humidity.map((next) => next());
    const [dhtTempC, dht2Temp] = dhtTemps.map((next) => next());

    const temp4C = args.missing ? null : temp4;
    const humidity2Pct = args.missing ? null : humidity2;
    // The second humidity sensor measures dht2TempC, so it goes with it.
    const dht2TempC = args.missing ? null : dht2Temp;
    const probes = [temp1C, temp2C, temp3C, temp4C].filter((value) => value !== null);

    const frame = {
      level: "off", levelValue: 0, manual: false, autoFan: false,
      tripped: false, climate: false,
      totalCurrentA: 0, sumCurrentA: 0, totalPowerW: 0, readingSource: "ct",
      temp1C, temp2C, temp3C, temp4C,
      maxTempC: Math.max(...probes),
      humidity1Pct, humidity2Pct,
      dhtTempC, dht2TempC,
      sensorsOk: [temp1C, temp2C, temp3C, temp4C, humidity1Pct, humidity2Pct].filter((value) => value !== null).length,
      deviceType: "temphum",
      wifi: "STA", ip: "192.168.1.50", bluetoothClient: false,
      apiKeySet: false, uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
      rssi: Math.round(rssi()),
      channels: [],
    };

    try {
      const result = await call(
        `${args.server}/api/devices/${id}/telemetry`,
        { "X-Device-Key": deviceKey, "X-Admin-Key": args.adminKey },
        frame,
      );
      sent += 1;
      const show = (value) => (value === null ? "  -- " : value.toFixed(1).padStart(5));
      console.log(
        `${new Date().toLocaleTimeString("en-GB")}  #${String(sent).padStart(4)}  HTTP ${result.status}  ` +
          `T ${[temp1C, temp2C, temp3C, temp4C].map(show).join(" ")}  ` +
          `H ${[humidity1Pct, humidity2Pct].map(show).join(" ")}  ` +
          (result.ok ? `next in ${result.json?.nextIntervalMs} ms (server's interval)` : `${result.json?.error ?? result.text.slice(0, 200)}`),
      );
    } catch (error) {
      console.log(`${new Date().toLocaleTimeString("en-GB")}  request failed: ${error.message}`);
    }

    if (stopping || sent >= args.count) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, args.interval * 1000);
      process.once("SIGINT", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  console.log(`sent ${sent} frame${sent === 1 ? "" : "s"}`);
}

main().catch((error) => {
  console.error(error.message);
  console.error(USAGE);
  process.exitCode = 1;
});
