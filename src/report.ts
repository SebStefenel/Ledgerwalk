import { relative, resolve } from 'node:path';

import { latestAudit, loadAlternatives } from './db/index.js';
import type { Db, StoredAlternative } from './db/index.js';
import { loadConfirmed, serviceNameFor } from './stage1/review-file.js';
import type { RecordCadence } from './stage1/review-file.js';

export interface ReportRow {
  readonly service: string;
  readonly annualCost: number;
  readonly amount: number;
  readonly currency: string | null;
  readonly cadence: RecordCadence;
  readonly planTier: string | null;
  readonly isTrial: boolean;
  readonly nextRenewal: string | null;
  readonly previousAmount: number | null;
  readonly priceChangedOn: string | null;
  readonly suggestion: StoredAlternative | null;
  /** trace directory of the most recent phase 2 run, if there was one */
  readonly traceDir: string | null;
  /** status of that run; null when the service has never been audited */
  readonly auditStatus: string | null;
}

/* ------------------------------------------------------------- assembling */

/**
 * Build the report from the three sources that hold the truth: the review file
 * (which subscriptions count, what they cost, and what receipts revealed), the
 * audits table (where the evidence lives), and the alternatives table.
 */
export function buildRows(db: Db, subscriptionsPath: string): ReportRow[] {
  const suggestions = new Map<string, StoredAlternative>();
  for (const row of loadAlternatives(db)) suggestions.set(row.service.toLowerCase(), row);

  return loadConfirmed(subscriptionsPath).map((record) => {
    const service = serviceNameFor(record);
    const audit = latestAudit(db, service);
    return {
      service,
      annualCost: record.annualCost,
      amount: record.amount,
      currency: record.currency,
      cadence: record.cadence,
      planTier: record.planTier,
      isTrial: record.isTrial,
      nextRenewal: record.nextRenewal,
      previousAmount: record.previousAmount,
      priceChangedOn: record.priceChangedOn,
      suggestion: suggestions.get(service.toLowerCase()) ?? null,
      traceDir: audit === null ? null : audit.traceDir,
      auditStatus: audit === null ? null : audit.status,
    };
  });
}

/* -------------------------------------------------------------- rendering */

function money(value: number): string {
  return value.toFixed(2);
}

function priced(row: { readonly amount: number; readonly currency: string | null }): string {
  return row.currency === null ? money(row.amount) : `${row.currency} ${money(row.amount)}`;
}

/** Markdown tables break on unescaped pipes and newlines. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

function traceLink(service: string, traceDir: string | null): string {
  if (traceDir === null) return cell(service);
  const rel = relative(resolve('.'), resolve(traceDir));
  const href = rel.startsWith('..') ? resolve(traceDir) : rel;
  return `[${cell(service)}](${href.replace(/ /g, '%20')})`;
}

function alternativeCell(suggestion: StoredAlternative | null): string {
  if (suggestion === null) return '_not checked_';
  if (suggestion.alternative === null) return '_none_';

  const parts: string[] = [
    suggestion.repoUrl === null
      ? cell(suggestion.alternative)
      : `[${cell(suggestion.alternative)}](${suggestion.repoUrl})`,
  ];
  if (suggestion.repoStars !== null) parts.push(`${suggestion.repoStars.toLocaleString('en-US')}★`);
  if (suggestion.repoStale === true) {
    parts.push(`**unmaintained since ${suggestion.repoLastCommit ?? 'unknown'}**`);
  }
  return parts.join(' · ');
}

/** Service name, plus the details a receipt or billing page told us. */
function serviceCell(row: ReportRow): string {
  const parts = [traceLink(row.service, row.traceDir)];
  if (row.planTier !== null) parts.push(`— ${cell(row.planTier)}`);
  if (row.isTrial) parts.push('**(trial)**');
  return parts.join(' ');
}

function percentChange(previous: number, current: number): string {
  if (previous <= 0) return '';
  const change = Math.round(((current - previous) / previous) * 100);
  return change === 0 ? '' : ` (${change > 0 ? '+' : ''}${change}%)`;
}

/** An audit that ran but did not read the page; null status means it never ran. */
const AUDIT_FAILURE_REASON: Readonly<Record<string, string>> = {
  auth_expired: 'the saved session had expired',
  step_limit: 'the agent ran out of steps before finding the billing page',
  gave_up: 'the agent could not reach the billing details',
  stopped_at_cancel: 'the agent stopped at a cancellation screen, as designed',
  error: 'the run failed with an error',
  dry_run: 'the last run was a dry run',
};

/**
 * The lines worth acting on, in order of how soon they matter: a trial about to
 * start charging, then a price that has gone up, then a service whose billing
 * page could not be read.
 */
function attentionLines(rows: readonly ReportRow[]): string[] {
  const lines: string[] = [];

  for (const row of rows.filter((item) => item.isTrial)) {
    const when = row.nextRenewal ?? 'an unstated date';
    lines.push(
      `- ⏳ **${row.service}** — free trial ends ${when}, then ${priced(row)} ${row.cadence} ` +
        `(${money(row.annualCost)}/year).`,
    );
  }

  const risen = rows
    .filter((row) => row.previousAmount !== null && row.previousAmount < row.amount)
    .sort((a, b) => b.amount - a.amount);
  for (const row of risen) {
    const previous = row.previousAmount ?? 0;
    lines.push(
      `- ↑ **${row.service}** — price rose from ${money(previous)} to ${money(row.amount)}` +
        `${percentChange(previous, row.amount)} on ${row.priceChangedOn ?? 'an unknown date'}.`,
    );
  }

  const fallen = rows.filter((row) => row.previousAmount !== null && row.previousAmount > row.amount);
  for (const row of fallen) {
    const previous = row.previousAmount ?? 0;
    lines.push(
      `- ↓ **${row.service}** — price fell from ${money(previous)} to ${money(row.amount)} ` +
        `on ${row.priceChangedOn ?? 'an unknown date'}.`,
    );
  }

  for (const row of rows) {
    if (row.auditStatus === null || row.auditStatus === 'extracted') continue;
    const reason = AUDIT_FAILURE_REASON[row.auditStatus] ?? row.auditStatus;
    lines.push(
      `- ⚠ **${row.service}** — billing page not read: ${reason}. Figures below come from ` +
        'statements and receipts only.',
    );
  }

  return lines;
}

function renewalLines(rows: readonly ReportRow[], now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  const upcoming = rows
    .filter((row): row is ReportRow & { nextRenewal: string } => row.nextRenewal !== null)
    .filter((row) => row.nextRenewal >= today)
    .sort((a, b) => a.nextRenewal.localeCompare(b.nextRenewal));

  if (upcoming.length === 0) return [];

  return [
    '',
    '## Upcoming renewals',
    '',
    '| Renews | Service | Amount |',
    '| --- | --- | ---: |',
    ...upcoming.map(
      (row) => `| ${row.nextRenewal} | ${cell(row.service)}${row.isTrial ? ' (trial ends)' : ''} | ${priced(row)} |`,
    ),
  ];
}

export function renderReport(rows: readonly ReportRow[], now: Date = new Date()): string {
  const totalSpend = rows.reduce((sum, row) => sum + row.annualCost, 0);
  const totalSavings = rows.reduce(
    (sum, row) => sum + (row.suggestion?.alternative === null ? 0 : row.suggestion?.annualSavings ?? 0),
    0,
  );
  const withAlternative = rows.filter((row) => row.suggestion?.alternative != null).length;
  const unchecked = rows.filter((row) => row.suggestion === null).length;

  const header = [
    '# Subscription audit',
    '',
    `Generated ${now.toISOString().slice(0, 10)}.`,
    '',
    `- **Total annual spend:** ${money(totalSpend)}`,
    `- **Plausible annual savings:** ${money(totalSavings)} ` +
      `(${withAlternative} of ${rows.length} subscription(s) have a real alternative)`,
  ];
  if (unchecked > 0) {
    header.push(`- ${unchecked} subscription(s) not yet checked — run \`npm run alternatives\``);
  }

  const attention = attentionLines(rows);
  const attentionSection = attention.length === 0 ? [] : ['', '## Needs attention', '', ...attention];

  const table = [
    '',
    '## Subscriptions',
    '',
    '| Service | Annual cost | Alternative | License | Self-host | Migration | Savings | Features lost |',
    '| --- | ---: | --- | --- | :---: | :---: | ---: | --- |',
    ...rows.map((row) => {
      const suggestion = row.suggestion;
      const hasAlternative = suggestion !== null && suggestion.alternative !== null;
      const rose = row.previousAmount !== null && row.previousAmount < row.amount;
      return [
        serviceCell(row),
        `${money(row.annualCost)}${rose ? ' ↑' : ''}`,
        alternativeCell(suggestion),
        hasAlternative ? cell(suggestion.license ?? '—') : '—',
        hasAlternative ? (suggestion.selfHostRequired === true ? 'yes' : 'no') : '—',
        hasAlternative ? cell(suggestion.migrationEffort ?? '—') : '—',
        hasAlternative ? money(suggestion.annualSavings ?? 0) : '—',
        hasAlternative && suggestion.featuresLost.length > 0
          ? cell(suggestion.featuresLost.join('; '))
          : '—',
      ].join(' | ');
    }),
  ].map((line) => (line.startsWith('|') || line === '' || line.startsWith('#') ? line : `| ${line} |`));

  const notes: string[] = [];
  for (const row of rows) {
    const suggestion = row.suggestion;
    if (suggestion === null) continue;
    const label = suggestion.alternative === null ? 'no alternative' : suggestion.alternative;
    const category =
      suggestion.alternative === null && suggestion.noAlternativeCategory !== null
        ? ` _(${suggestion.noAlternativeCategory.replace(/_/g, ' ')})_`
        : '';
    notes.push(
      `- **${row.service}** — ${label}${category}: ${suggestion.reason} ` +
        `_(confidence: ${suggestion.confidence})_`,
    );
  }

  const footer = [
    '',
    '## Notes',
    '',
    ...(notes.length > 0 ? notes : ['- Nothing checked yet.']),
    '',
    '---',
    '',
    'A linked service name means its billing page was read by the agent; the link goes to',
    'that run\'s trace directory. This tool reads billing pages only and never completes a',
    'cancellation.',
  ];

  return [...header, ...attentionSection, ...renewalLines(rows, now), ...table, ...footer].join('\n');
}
