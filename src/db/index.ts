import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DetectedSubscription } from '../stage1/parse-statements.js';

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));

/** schema.sql sits next to this file when run from source, and is copied next to
 *  the compiled output by `npm run build`. Fall back to the source tree so a
 *  half-configured build still works. */
function schemaPath(): string {
  const beside = resolve(HERE, 'schema.sql');
  if (existsSync(beside)) return beside;
  const fromSource = resolve(HERE, '../../../src/db/schema.sql');
  if (existsSync(fromSource)) return fromSource;
  throw new Error(`Cannot locate schema.sql (looked in ${beside} and ${fromSource})`);
}

export function openDb(path: string): Db {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(readFileSync(schemaPath(), 'utf8'));
  return db;
}

/**
 * Upsert detected subscriptions and their charges. Re-running a scan over the
 * same statements is idempotent: subscriptions match on normalized_name and
 * charges on their natural key.
 *
 * `confirmed` is deliberately never written here — that flag belongs to the
 * hand-edited subscriptions.json, and a re-scan must not silently clear it.
 */
export function saveSubscriptions(db: Db, subs: readonly DetectedSubscription[]): void {
  const upsertSub = db.prepare<[string, string, string, number, number, string, string, number]>(`
    INSERT INTO subscriptions
      (merchant, normalized_name, cadence, amount, charge_count, first_seen, last_seen, annual_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (normalized_name) DO UPDATE SET
      merchant     = excluded.merchant,
      cadence      = excluded.cadence,
      amount       = excluded.amount,
      charge_count = excluded.charge_count,
      first_seen   = excluded.first_seen,
      last_seen    = excluded.last_seen,
      annual_cost  = excluded.annual_cost,
      updated_at   = datetime('now')
  `);

  const findSubId = db.prepare<[string], { id: number }>(
    'SELECT id FROM subscriptions WHERE normalized_name = ?',
  );

  const insertCharge = db.prepare<[number, string, string, number, string]>(`
    INSERT OR IGNORE INTO charges
      (subscription_id, charged_on, description, amount, source_file)
    VALUES (?, ?, ?, ?, ?)
  `);

  const write = db.transaction((rows: readonly DetectedSubscription[]) => {
    for (const sub of rows) {
      upsertSub.run(
        sub.merchant,
        sub.normalizedName,
        sub.cadence,
        sub.amount,
        sub.chargeCount,
        sub.firstSeen,
        sub.lastSeen,
        sub.annualCost,
      );
      const row = findSubId.get(sub.normalizedName);
      if (row === undefined) throw new Error(`upsert failed for ${sub.normalizedName}`);
      for (const charge of sub.charges) {
        insertCharge.run(row.id, charge.date, charge.description, charge.amount, charge.sourceFile);
      }
    }
  });

  write(subs);
}
