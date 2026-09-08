import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { DetectedSubscription } from './parse-statements.js';
import type { ReceiptSubscription } from './receipts.js';
import { annualCostOf } from './receipts.js';

/** Statements can only distinguish monthly from annual; receipts state the cadence outright. */
export type RecordCadence = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export type DiscoveredBy = 'statement' | 'email';

/** One row of the hand-editable review file. */
export interface SubscriptionRecord {
  readonly merchant: string;
  readonly normalizedName: string;
  readonly cadence: RecordCadence;
  readonly amount: number;
  readonly chargeCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly annualCost: number;
  /** set false to exclude a row from later phases */
  readonly confirmed: boolean;
  /** optional link to a tasks/services.yaml entry, filled in by hand */
  readonly service: string | null;
  readonly discoveredBy: DiscoveredBy;
  /** these four are only knowable from a receipt */
  readonly planTier: string | null;
  readonly currency: string | null;
  readonly nextRenewal: string | null;
  readonly isTrial: boolean;
  /** the last materially different price, when a statement shows one */
  readonly previousAmount: number | null;
  /** date of the first charge at the current price */
  readonly priceChangedOn: string | null;
}

export interface SubscriptionFile {
  readonly generatedAt: string;
  readonly note: string;
  readonly subscriptions: readonly SubscriptionRecord[];
}

export const REVIEW_NOTE =
  'Edit freely. Set confirmed:false to drop a row from later phases; set "service" ' +
  'to the matching name in tasks/services.yaml. Re-running scan or inbox preserves ' +
  'both fields, and neither command deletes rows found by the other.';

const CADENCES: readonly RecordCadence[] = ['weekly', 'monthly', 'quarterly', 'annual'];

/* ------------------------------------------------------------ reading  in */

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Fill in fields a file written by an older version will not have, so upgrading
 * never invalidates a review file the user has already hand-edited.
 */
function normalizeRecord(raw: unknown): SubscriptionRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Readonly<Record<string, unknown>>;

  const normalizedName = asString(record['normalizedName']);
  if (normalizedName === null) return null;

  const cadence = CADENCES.find((option) => option === record['cadence']) ?? 'monthly';
  const amount = asNumber(record['amount'], 0);
  const discoveredBy = record['discoveredBy'] === 'email' ? 'email' : 'statement';

  return {
    merchant: asString(record['merchant']) ?? normalizedName,
    normalizedName,
    cadence,
    amount,
    chargeCount: Math.max(0, Math.trunc(asNumber(record['chargeCount'], 0))),
    firstSeen: asString(record['firstSeen']) ?? '',
    lastSeen: asString(record['lastSeen']) ?? '',
    annualCost: asNumber(record['annualCost'], annualCostOf(amount, cadence)),
    confirmed: record['confirmed'] !== false,
    service: asString(record['service']),
    discoveredBy,
    planTier: asString(record['planTier']),
    currency: asString(record['currency']),
    nextRenewal: asString(record['nextRenewal']),
    isTrial: record['isTrial'] === true,
    previousAmount:
      typeof record['previousAmount'] === 'number' && Number.isFinite(record['previousAmount'])
        ? record['previousAmount']
        : null,
    priceChangedOn: asString(record['priceChangedOn']),
  };
}

function readRecords(path: string): SubscriptionRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SubscriptionFile>;
    const rows = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
    return rows.map(normalizeRecord).filter((row): row is SubscriptionRecord => row !== null);
  } catch {
    return [];
  }
}

function indexByName(records: readonly SubscriptionRecord[]): Map<string, SubscriptionRecord> {
  const index = new Map<string, SubscriptionRecord>();
  for (const record of records) index.set(record.normalizedName, record);
  return index;
}

function file(subscriptions: readonly SubscriptionRecord[]): SubscriptionFile {
  return {
    generatedAt: new Date().toISOString(),
    note: REVIEW_NOTE,
    subscriptions: [...subscriptions].sort((a, b) => b.annualCost - a.annualCost),
  };
}

/* ------------------------------------------------------------- merging in */

/**
 * Fold a statement scan into the review file.
 *
 * Hand edits survive, and so do rows discovered from email: a statement scan has
 * nothing to say about those, so silently dropping them would lose the only
 * record of a subscription that a bank line cannot show on its own.
 */
export function mergeWithExisting(
  detected: readonly DetectedSubscription[],
  path: string,
): SubscriptionFile {
  const previous = indexByName(readRecords(path));
  if (existsSync(path) && previous.size === 0) {
    console.warn(`! ${path} is not valid JSON — writing a fresh file`);
  }

  const detectedNames = new Set(detected.map((sub) => sub.normalizedName));

  const fromStatements: SubscriptionRecord[] = detected.map((sub) => {
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
      discoveredBy: 'statement',
      // Anything a receipt taught us about this service is kept.
      planTier: prior?.planTier ?? null,
      currency: prior?.currency ?? null,
      nextRenewal: prior?.nextRenewal ?? null,
      isTrial: prior?.isTrial ?? false,
      // Price movement is re-derived from the charges every scan, so it is taken
      // from the detection rather than from whatever the file said last time.
      previousAmount: sub.previousAmount,
      priceChangedOn: sub.priceChangedOn,
    };
  });

  const emailOnly = [...previous.values()].filter(
    (record) => record.discoveredBy === 'email' && !detectedNames.has(record.normalizedName),
  );

  return file([...fromStatements, ...emailOnly]);
}

/**
 * Fold receipt findings into the review file.
 *
 * Where a service was already found in a statement, the statement keeps
 * authority over the money — it is what actually left the account — and the
 * receipt contributes only what a bank line cannot know: the plan tier, the
 * currency, the renewal date, and whether it is still a trial.
 */
export function mergeEmailFindings(
  receipts: readonly ReceiptSubscription[],
  path: string,
): SubscriptionFile {
  const merged = indexByName(readRecords(path));

  for (const receipt of receipts) {
    const prior = merged.get(receipt.normalizedName);

    if (prior !== undefined) {
      merged.set(receipt.normalizedName, {
        ...prior,
        planTier: receipt.planTier ?? prior.planTier,
        currency: receipt.currency ?? prior.currency,
        nextRenewal: receipt.nextRenewal ?? prior.nextRenewal,
        isTrial: receipt.isTrial || prior.isTrial,
        // A statement row keeps its own figures; an email row is refreshed.
        ...(prior.discoveredBy === 'email'
          ? {
              merchant: receipt.vendor,
              cadence: receipt.cadence,
              amount: receipt.amount,
              annualCost: annualCostOf(receipt.amount, receipt.cadence),
              lastSeen: receipt.seenOn,
              chargeCount: prior.chargeCount + (receipt.seenOn > prior.lastSeen ? 1 : 0),
            }
          : {}),
      });
      continue;
    }

    merged.set(receipt.normalizedName, {
      merchant: receipt.vendor,
      normalizedName: receipt.normalizedName,
      cadence: receipt.cadence,
      amount: receipt.amount,
      chargeCount: 1,
      firstSeen: receipt.seenOn,
      lastSeen: receipt.seenOn,
      annualCost: annualCostOf(receipt.amount, receipt.cadence),
      confirmed: true,
      service: null,
      discoveredBy: 'email',
      planTier: receipt.planTier,
      currency: receipt.currency,
      nextRenewal: receipt.nextRenewal,
      isTrial: receipt.isTrial,
      previousAmount: null,
      priceChangedOn: null,
    });
  }

  return file([...merged.values()]);
}

/* ----------------------------------------------------------------- output */

export function writeReviewFile(path: string, contents: SubscriptionFile): void {
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

/** Rows the user has confirmed, largest annual cost first. */
export function loadConfirmed(path: string): readonly SubscriptionRecord[] {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`npm run scan\` or \`npm run inbox\` first`);
  }
  return readRecords(path).filter((row) => row.confirmed);
}

/**
 * The name a service is known by downstream.
 *
 * The hand-set `service` wins, because it is the one name that matches
 * tasks/services.yaml. Otherwise use the normalised name — "NETFLIX" rather than
 * the raw "NETFLIX.COM 8667797" — since that is both a better prompt for phase 3
 * and a better label in the report. The raw merchant string is a last resort.
 */
export function serviceNameFor(record: SubscriptionRecord): string {
  const mapped = record.service;
  if (typeof mapped === 'string' && mapped.trim() !== '') return mapped.trim();
  const normalized = record.normalizedName;
  if (typeof normalized === 'string' && normalized.trim() !== '') return normalized.trim();
  return record.merchant;
}
