import { relative, resolve } from 'node:path';

import { latestAudit, loadAlternatives } from './db/index.js';
import type { Db, StoredAlternative } from './db/index.js';
import { loadConfirmed, serviceNameFor } from './stage1/review-file.js';

export interface ReportRow {
  readonly service: string;
  readonly annualCost: number;
  readonly suggestion: StoredAlternative | null;
  /** trace directory of the most recent phase 2 run, if there was one */
  readonly traceDir: string | null;
}

/* ------------------------------------------------------------- assembling */

/**
 * Build the report from the three sources that hold the truth: the review file
 * (which subscriptions count, and what they cost), the audits table (where the
 * evidence lives), and the alternatives table.
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
      suggestion: suggestions.get(service.toLowerCase()) ?? null,
      traceDir: audit === null ? null : audit.traceDir,
    };
  });
}

/* -------------------------------------------------------------- rendering */

function money(value: number): string {
  return value.toFixed(2);
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

  const table = [
    '',
    '| Service | Annual cost | Alternative | License | Self-host | Migration | Savings | Features lost |',
    '| --- | ---: | --- | --- | :---: | :---: | ---: | --- |',
    ...rows.map((row) => {
      const suggestion = row.suggestion;
      const hasAlternative = suggestion !== null && suggestion.alternative !== null;
      return [
        traceLink(row.service, row.traceDir),
        money(row.annualCost),
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
  ].map((line) => (line.startsWith('|') || line === '' ? line : `| ${line} |`));

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
    'Each service links to the trace directory for its audit run. This tool reads billing',
    'pages only and never completes a cancellation.',
  ];

  return [...header, ...table, ...footer].join('\n');
}
