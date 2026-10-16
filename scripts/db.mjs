#!/usr/bin/env node
/**
 * Database setup and migration runner.
 *
 * Deliberately dependency-free beyond `pg`, which the app already needs, and
 * deliberately not a framework: the schema is one checked-in file plus an
 * ordered list of migrations, which is all this project needs to be
 * recreatable on another machine.
 *
 *   node scripts/db.mjs setup     apply db/schema.sql to an empty database
 *   node scripts/db.mjs migrate   apply any migrations not yet recorded
 *   node scripts/db.mjs status    show what is applied and what is pending
 *
 * Connection comes from DATABASE_URL (or HEATER_DATABASE_URL), falling back to
 * the local development database.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "db", "migrations");
const schemaFile = join(root, "db", "schema.sql");

const connectionString =
  process.env.DATABASE_URL ??
  process.env.HEATER_DATABASE_URL ??
  "postgresql://heater@localhost:5432/heaterfan";

const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });

/** Records which migrations have run, so `migrate` is safe to repeat. */
async function ensureLedger() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename    text        PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrations() {
  try {
    const files = await readdir(migrationsDir);
    return files.filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }
}

async function appliedMigrations() {
  await ensureLedger();
  const { rows } = await pool.query("SELECT filename FROM public.schema_migrations");
  return new Set(rows.map((r) => r.filename));
}

/**
 * pg_dump 17 wraps its output in psql-only \restrict / \unrestrict guards.
 * They are meta-commands, not SQL, so they have to go before the file can be
 * executed over a normal connection.
 *
 * It also emits `SET transaction_timeout`, a parameter that only exists from
 * PostgreSQL 17. Older servers reject the whole dump with "unrecognized
 * configuration parameter", so the line is dropped; it is a no-op default.
 */
function stripPsqlMetaCommands(sql) {
  return sql
    .split("\n")
    .filter((line) => !/^\\(restrict|unrestrict)\b/.test(line.trim()))
    .filter((line) => !/^SET\s+transaction_timeout\b/i.test(line.trim()))
    .join("\n");
}

/**
 * `gen_random_uuid()` is built into PostgreSQL 13+. On older servers it comes
 * from the pgcrypto extension in `public`, and the dump empties search_path
 * before any CREATE TABLE runs, so the bare name cannot be resolved there.
 * Qualifying it only on those servers keeps the dump untouched for 13+, where
 * pgcrypto no longer ships the function and `public.gen_random_uuid()` would
 * be the thing that fails.
 */
async function adaptForServer(sql) {
  const { rows } = await pool.query("SHOW server_version_num");
  const version = Number(rows[0].server_version_num);
  if (version < 130000) {
    sql = sql.replace(/(?<![\w.])gen_random_uuid\(\)/g, "public.gen_random_uuid()");
  }
  return sql;
}

async function setup() {
  const sql = await adaptForServer(stripPsqlMetaCommands(await readFile(schemaFile, "utf8")));
  await pool.query(sql);
  await ensureLedger();

  // A database created from schema.sql already contains everything the
  // migrations would add, so record them as applied rather than re-running
  // them against a schema that is already current.
  for (const filename of await listMigrations()) {
    await pool.query(
      "INSERT INTO public.schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
      [filename],
    );
  }
  console.log(`schema applied from db/schema.sql`);
}

async function migrate() {
  const applied = await appliedMigrations();
  const pending = (await listMigrations()).filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("nothing to migrate");
    return;
  }

  for (const filename of pending) {
    const sql = stripPsqlMetaCommands(await readFile(join(migrationsDir, filename), "utf8"));
    process.stdout.write(`applying ${filename} ... `);
    // Each migration manages its own BEGIN/COMMIT so it can contain DDL that
    // must not share a transaction with the ledger write.
    await pool.query(sql);
    await pool.query(
      "INSERT INTO public.schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
      [filename],
    );
    console.log("ok");
  }
}

async function status() {
  const applied = await appliedMigrations();
  const all = await listMigrations();
  const { rows } = await pool.query(
    "SELECT current_database() AS db, current_user AS usr",
  );
  console.log(`database: ${rows[0].db} (as ${rows[0].usr})`);
  if (all.length === 0) console.log("no migrations found");
  for (const filename of all) {
    console.log(`  ${applied.has(filename) ? "applied" : "PENDING"}  ${filename}`);
  }
}

const command = process.argv[2] ?? "status";
const commands = { setup, migrate, status };

try {
  if (!commands[command]) {
    console.error(`unknown command "${command}" — expected setup, migrate or status`);
    process.exitCode = 1;
  } else {
    await commands[command]();
  }
} catch (error) {
  console.error(`\n${command} failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
