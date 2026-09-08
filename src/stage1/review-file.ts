import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { DetectedSubscription } from './parse-statements.js';

/** One row of the hand-editable review file produced by `scan`. */
export interface SubscriptionRecord {
  readonly merchant: string;
  readonly normalizedName: string;
  readonly cadence: 'monthly' | 'annual';
  readonly amount: number;
  readonly chargeCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly annualCost: number;
  /** set false to exclude a row from later phases */
  readonly confirmed: boolean;
  /** optional link to a tasks/services.yaml entry, filled in by hand */
  readonly service: string | null;
}

export interface SubscriptionFile {
  readonly generatedAt: string;
  readonly note: string;
  readonly subscriptions: readonly SubscriptionRecord[];
}

export const REVIEW_NOTE =
  'Edit freely. Set confirmed:false to drop a row from later phases; set "service" ' +
  'to the matching name in tasks/services.yaml. Re-running scan preserves both fields.';

function readRecords(path: string): Map<string, SubscriptionRecord> {
  const found = new Map<string, SubscriptionRecord>();
  if (!existsSync(path)) return found;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SubscriptionFile>;
    for (const record of parsed.subscriptions ?? []) {
      if (typeof record.normalizedName === 'string') found.set(record.normalizedName, record);
    }
  } catch {
    /* caller decides what to do about an unreadable file */
  }
  return found;
}

/** Carry the user's hand edits across a re-scan. */
export function mergeWithExisting(
  detected: readonly DetectedSubscription[],
  path: string,
): SubscriptionFile {
  const previous = readRecords(path);
  if (existsSync(path) && previous.size === 0) {
    console.warn(`! ${path} is not valid JSON — writing a fresh file`);
  }

  return {
    generatedAt: new Date().toISOString(),
    note: REVIEW_NOTE,
    subscriptions: detected.map((sub) => {
      const prior = previous.get(sub.normalizedName);
      return {
        merchant: sub.merchant,
        normalizedName: sub.normalizedName,
        cadence: sub.cadence,
        amount: sub.amount,
        chargeCount: sub.chargeCount,
        firstSeen: sub.firstSeen,
        lastSeen: sub.lastSeen,
        annualCost: sub.annualCost,
        confirmed: prior?.confirmed ?? true,
        service: prior?.service ?? null,
      };
    }),
  };
}

export function writeReviewFile(path: string, file: SubscriptionFile): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Rows the user has confirmed, in the order they appear in the file. */
export function loadConfirmed(path: string): readonly SubscriptionRecord[] {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`npm run scan\` first`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SubscriptionFile>;
  const rows = parsed.subscriptions ?? [];
  return rows.filter((row) => row.confirmed !== false);
}

/**
 * The name a service is known by downstream.
 *
 * The hand-set `service` wins, because it is the one name that matches
 * tasks/services.yaml. Otherwise use the normalised name from phase 1 —
 * "NETFLIX" rather than the raw "NETFLIX.COM 8667797" — since that is both a
 * better prompt for phase 3 and a better label in the report. The raw merchant
 * string is only a last resort.
 */
export function serviceNameFor(record: SubscriptionRecord): string {
  const mapped = record.service;
  if (typeof mapped === 'string' && mapped.trim() !== '') return mapped.trim();
  const normalized = record.normalizedName;
  if (typeof normalized === 'string' && normalized.trim() !== '') return normalized.trim();
  return record.merchant;
}
