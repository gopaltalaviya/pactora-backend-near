#!/usr/bin/env node
/**
 * Apply migrations in filename order, tracked in a ledger table.
 *
 * Deliberately plain: drizzle-kit generates the schema DDL, and 0001+ are
 * hand-written constraint files it cannot express. Both are just SQL, applied
 * once each, inside a transaction.
 *
 * Two runs at once — two replicas deploying together — are serialised by an
 * advisory lock held on the runner's single connection: the second waits,
 * then finds everything applied. Without it both could read the same ledger
 * and apply the same file twice.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import postgres from 'postgres';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Required. It used to fall back to the local docker URL, so a deploy with the
// variable missing "succeeded" against a database that was not there — or,
// worse, against one that was.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — refusing to guess which database to migrate');
  process.exit(2);
}

/** Arbitrary, fixed: the one lock every migration run agrees on. */
const MIGRATION_LOCK = 7_314_159_265n;

const sql = postgres(url, {max: 1, onnotice: () => {}});

let count = 0;
try {
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK.toString()}::bigint)`;

  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  // Read AFTER taking the lock: a run that waited must see what the other applied.
  const applied = new Set((await sql`SELECT name FROM _migrations`).map((r) => r.name));
  const files = readdirSync(join(ROOT, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const ddl = readFileSync(join(ROOT, 'migrations', file), 'utf8');
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      console.log(`✓ ${file}`);
      count++;
    } catch (err) {
      console.error(`✗ ${file}\n  ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  // max: 1, so the unlock runs on the connection that took the lock.
  await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK.toString()}::bigint)`.catch(() => {});
  await sql.end();
}

if (!process.exitCode) console.log(count === 0 ? 'already up to date' : `applied ${count} migration(s)`);
