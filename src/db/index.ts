import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DetectedSubscription } from '../stage1/parse-statements.js';
import type { TaskResult } from '../trace/logger.js';

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

/** Record one agent run. Runs are append-only: the history is the audit trail. */
export function saveAudit(db: Db, result: TaskResult, traceDir: string): void {
  db.prepare(`
    INSERT INTO audits
      (service, status, fields_json, reason, steps, input_tokens, output_tokens,
       trace_dir, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.service,
    result.status,
    result.fields === null ? null : JSON.stringify(result.fields),
    result.reason,
    result.steps,
    result.tokens.input,
    result.tokens.output,
    traceDir,
    result.startedAt,
    result.finishedAt,
  );
}

export interface AuditRow {
  readonly service: string;
  readonly status: string;
  readonly fields: Readonly<Record<string, string>> | null;
  readonly traceDir: string;
  readonly finishedAt: string;
}

function parseFields(json: string | null): Readonly<Record<string, string>> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/** Most recent run for a service, whatever its status. */
export function latestAudit(db: Db, service: string): AuditRow | null {
  const row = db
    .prepare<[string], {
      service: string;
      status: string;
      fields_json: string | null;
      trace_dir: string;
      finished_at: string;
    }>(
      `SELECT service, status, fields_json, trace_dir, finished_at
         FROM audits
        WHERE lower(service) = lower(?)
        ORDER BY finished_at DESC
        LIMIT 1`,
    )
    .get(service);

  if (row === undefined) return null;
  return {
    service: row.service,
    status: row.status,
    fields: parseFields(row.fields_json),
    traceDir: row.trace_dir,
    finishedAt: row.finished_at,
  };
}

export interface StoredAlternative {
  readonly service: string;
  readonly normalizedName: string | null;
  readonly annualCost: number;
  readonly alternative: string | null;
  readonly reason: string;
  readonly noAlternativeCategory: string | null;
  readonly repoUrl: string | null;
  readonly license: string | null;
  readonly selfHostRequired: boolean | null;
  readonly migrationEffort: string | null;
  readonly annualSavings: number | null;
  readonly featuresLost: readonly string[];
  readonly confidence: string;
  readonly repoStars: number | null;
  readonly repoLastCommit: string | null;
  readonly repoStale: boolean | null;
}

/** One row per service; re-running replaces the previous suggestion. */
export function saveAlternative(db: Db, row: StoredAlternative): void {
  db.prepare(`
    INSERT INTO alternatives
      (service, normalized_name, annual_cost, alternative, reason, no_alternative_category,
       repo_url, license, self_host_required, migration_effort, annual_savings, features_lost,
       confidence, repo_stars, repo_last_commit, repo_stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (service) DO UPDATE SET
      normalized_name         = excluded.normalized_name,
      annual_cost             = excluded.annual_cost,
      alternative             = excluded.alternative,
      reason                  = excluded.reason,
      no_alternative_category = excluded.no_alternative_category,
      repo_url                = excluded.repo_url,
      license                 = excluded.license,
      self_host_required      = excluded.self_host_required,
      migration_effort        = excluded.migration_effort,
      annual_savings          = excluded.annual_savings,
      features_lost           = excluded.features_lost,
      confidence              = excluded.confidence,
      repo_stars              = excluded.repo_stars,
      repo_last_commit        = excluded.repo_last_commit,
      repo_stale              = excluded.repo_stale,
      updated_at              = datetime('now')
  `).run(
    row.service,
    row.normalizedName,
    row.annualCost,
    row.alternative,
    row.reason,
    row.noAlternativeCategory,
    row.repoUrl,
    row.license,
    row.selfHostRequired === null ? null : row.selfHostRequired ? 1 : 0,
    row.migrationEffort,
    row.annualSavings,
    JSON.stringify(row.featuresLost),
    row.confidence,
    row.repoStars,
    row.repoLastCommit,
    row.repoStale === null ? null : row.repoStale ? 1 : 0,
  );
}

export function loadAlternatives(db: Db): StoredAlternative[] {
  const rows = db
    .prepare<[], {
      service: string;
      normalized_name: string | null;
      annual_cost: number;
      alternative: string | null;
      reason: string;
      no_alternative_category: string | null;
      repo_url: string | null;
      license: string | null;
      self_host_required: number | null;
      migration_effort: string | null;
      annual_savings: number | null;
      features_lost: string | null;
      confidence: string;
      repo_stars: number | null;
      repo_last_commit: string | null;
      repo_stale: number | null;
    }>('SELECT * FROM alternatives ORDER BY annual_cost DESC')
    .all();

  return rows.map((row) => {
    let featuresLost: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.features_lost ?? '[]');
      if (Array.isArray(parsed)) {
        featuresLost = parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      featuresLost = [];
    }
    return {
      service: row.service,
      normalizedName: row.normalized_name,
      annualCost: row.annual_cost,
      alternative: row.alternative,
      reason: row.reason,
      noAlternativeCategory: row.no_alternative_category,
      repoUrl: row.repo_url,
      license: row.license,
      selfHostRequired: row.self_host_required === null ? null : row.self_host_required === 1,
      migrationEffort: row.migration_effort,
      annualSavings: row.annual_savings,
      featuresLost,
      confidence: row.confidence,
      repoStars: row.repo_stars,
      repoLastCommit: row.repo_last_commit,
      repoStale: row.repo_stale === null ? null : row.repo_stale === 1,
    };
  });
}
