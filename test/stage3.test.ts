import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkRepoHealth,
  isStale,
  parseGitHubRepo,
  parseSuggestion,
  renderRequest,
  suggestAlternative,
} from '../src/stage3/alternatives.js';
import { buildRows, renderReport } from '../src/report.js';
import type { ReportRow } from '../src/report.js';
import { latestAudit, openDb, saveAlternative, saveAudit } from '../src/db/index.js';
import type { StoredAlternative } from '../src/db/index.js';
import { ScriptedModel } from './fixtures/scripted-model.js';

/* ------------------------------------------------------------- validation */

test('a well-formed suggestion parses into a typed alternative', () => {
  const parsed = parseSuggestion(
    {
      alternative: 'AppFlowy',
      reason: 'Covers the same documents-and-databases model.',
      noAlternativeCategory: null,
      repoUrl: 'https://github.com/AppFlowy-IO/AppFlowy',
      license: 'AGPL-3.0',
      selfHostRequired: false,
      migrationEffort: 'medium',
      annualSavings: 90,
      featuresLost: ['weaker mobile apps', ''],
      confidence: 'high',
    },
    96,
  );

  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.suggestion.kind !== 'alternative') return;
  const value = parsed.suggestion.value;
  assert.equal(value.alternative, 'AppFlowy');
  assert.equal(value.license, 'AGPL-3.0');
  assert.equal(value.selfHostRequired, false);
  assert.equal(value.migrationEffort, 'medium');
  assert.equal(value.annualSavings, 90);
  assert.deepEqual(value.featuresLost, ['weaker mobile apps'], 'empty strings dropped');
  assert.equal(value.repoHealth, null, 'health is filled in separately');
});

test('a refusal parses into a categorised "none"', () => {
  const parsed = parseSuggestion(
    {
      alternative: null,
      reason: 'Prime is physical delivery bundled with a licensed catalogue.',
      noAlternativeCategory: 'physical_logistics',
      featuresLost: [],
      confidence: 'high',
    },
    139,
  );

  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.suggestion.kind !== 'none') return;
  assert.equal(parsed.suggestion.category, 'physical_logistics');
  assert.match(parsed.suggestion.reason, /physical delivery/);
});

test('savings can never exceed what is actually being paid', () => {
  const inflated = parseSuggestion(
    { alternative: 'Thing', reason: 'x', featuresLost: [], confidence: 'high', annualSavings: 5000 },
    96,
  );
  assert.equal(inflated.ok, true);
  if (inflated.ok && inflated.suggestion.kind === 'alternative') {
    assert.equal(inflated.suggestion.value.annualSavings, 96);
  }

  const negative = parseSuggestion(
    { alternative: 'Thing', reason: 'x', featuresLost: [], confidence: 'high', annualSavings: -20 },
    96,
  );
  if (negative.ok && negative.suggestion.kind === 'alternative') {
    assert.equal(negative.suggestion.value.annualSavings, 0);
  }

  const omitted = parseSuggestion(
    { alternative: 'Thing', reason: 'x', featuresLost: [], confidence: 'high' },
    96,
  );
  if (omitted.ok && omitted.suggestion.kind === 'alternative') {
    assert.equal(omitted.suggestion.value.annualSavings, 96, 'defaults to the full cost');
  }
});

test('unusable output is rejected and odd enums fall back safely', () => {
  assert.equal(parseSuggestion({ alternative: 'X', featuresLost: [] }, 10).ok, false, 'reason required');
  assert.equal(parseSuggestion('not an object', 10).ok, false);

  const odd = parseSuggestion(
    {
      alternative: 'Thing',
      reason: 'x',
      featuresLost: 'not an array',
      confidence: 'extremely high',
      migrationEffort: 'trivial',
    },
    10,
  );
  assert.equal(odd.ok, true);
  if (odd.ok && odd.suggestion.kind === 'alternative') {
    assert.equal(odd.suggestion.value.confidence, 'low', 'unknown confidence is not trusted');
    assert.equal(odd.suggestion.value.migrationEffort, 'medium');
    assert.deepEqual(odd.suggestion.value.featuresLost, []);
  }
});

/* ----------------------------------------------------------------- github */

test('github URLs are parsed and non-github URLs ignored', () => {
  assert.deepEqual(parseGitHubRepo('https://github.com/AppFlowy-IO/AppFlowy'), {
    owner: 'AppFlowy-IO',
    repo: 'AppFlowy',
  });
  assert.deepEqual(parseGitHubRepo('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.equal(parseGitHubRepo('https://gitlab.com/owner/repo'), null);
  assert.equal(parseGitHubRepo('https://github.com/owner'), null);
  assert.equal(parseGitHubRepo('not a url'), null);
});

test('a repo untouched for 18 months is stale', () => {
  const now = new Date('2026-09-07T00:00:00Z');
  assert.equal(isStale('2026-06-01T00:00:00Z', now), false);
  assert.equal(isStale('2025-04-01T00:00:00Z', now), false, 'just under 18 months');
  assert.equal(isStale('2024-01-01T00:00:00Z', now), true);
  assert.equal(isStale('nonsense', now), false, 'an unparseable date is not a claim of staleness');
});

test('repo health is read from the API, and any failure is silent', async () => {
  const now = new Date('2026-09-07T00:00:00Z');
  const ok = await checkRepoHealth(
    'https://github.com/AppFlowy-IO/AppFlowy',
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ stargazers_count: 63000, pushed_at: '2026-08-30T12:00:00Z' }),
      }),
    now,
  );
  assert.deepEqual(ok, { stars: 63000, lastCommit: '2026-08-30', stale: false });

  const rateLimited = await checkRepoHealth(
    'https://github.com/owner/repo',
    () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }),
    now,
  );
  assert.equal(rateLimited, null, 'rate limiting is skipped silently');

  const threw = await checkRepoHealth(
    'https://github.com/owner/repo',
    () => Promise.reject(new Error('offline')),
    now,
  );
  assert.equal(threw, null);

  const stale = await checkRepoHealth(
    'https://github.com/owner/repo',
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ stargazers_count: 12, pushed_at: '2023-01-01T00:00:00Z' }),
      }),
    now,
  );
  assert.equal(stale?.stale, true);
});

/* ------------------------------------------------------------- the  call */

test('the request names the service, plan and annual cost', () => {
  const text = renderRequest({ service: 'Notion', planTier: 'Plus', annualCost: 96 });
  assert.match(text, /SERVICE: Notion/);
  assert.match(text, /PLAN: Plus/);
  assert.match(text, /ANNUAL COST: 96\.00/);
  assert.match(renderRequest({ service: 'X', planTier: null, annualCost: 1 }), /PLAN: \(unknown\)/);
});

test('the call carries two worked examples, one of them a refusal', async () => {
  const model = new ScriptedModel([
    {
      tool: 'report_alternative',
      input: {
        alternative: 'Outline',
        reason: 'Team wiki with the same shape.',
        repoUrl: 'https://github.com/outline/outline',
        license: 'BSL-1.1',
        selfHostRequired: true,
        migrationEffort: 'medium',
        annualSavings: 60,
        featuresLost: ['no databases'],
        confidence: 'medium',
      },
    },
  ]);

  const parsed = await suggestAlternative({
    input: { service: 'Confluence', planTier: 'Standard', annualCost: 120 },
    model,
    verifyRepo: false,
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.suggestion.kind === 'alternative') {
    assert.equal(parsed.suggestion.value.alternative, 'Outline');
    assert.equal(parsed.suggestion.value.repoHealth, null, 'repo check skipped when asked');
  }

  const call = model.calls[0];
  assert.ok(call !== undefined);

  // The refusal has to be demonstrated, not just described, or the model drifts
  // into inventing an alternative for everything.
  const serialised = JSON.stringify(call.messages);
  assert.match(serialised, /Notion/, 'substitutable example present');
  assert.match(serialised, /Amazon Prime/, 'non-substitutable example present');
  assert.match(serialised, /physical_logistics/, 'the refusal is shown as a tool call');

  const assistantTurns = call.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistantTurns.length, 2, 'exactly two worked examples');

  assert.deepEqual(call.toolChoice, { type: 'tool', name: 'report_alternative' });
  assert.equal(call.tools.length, 1);
  assert.match(call.system, /content_licensing/);
  assert.match(call.system, /honest null/);

  assert.match(model.lastPrompts[0] ?? '', /SERVICE: Confluence/, 'the live request comes last');
});

test('a repo URL triggers a health lookup that lands on the result', async () => {
  const model = new ScriptedModel([
    {
      tool: 'report_alternative',
      input: {
        alternative: 'AppFlowy',
        reason: 'Same model.',
        repoUrl: 'https://github.com/AppFlowy-IO/AppFlowy',
        license: 'AGPL-3.0',
        selfHostRequired: false,
        migrationEffort: 'low',
        annualSavings: 96,
        featuresLost: [],
        confidence: 'high',
      },
    },
  ]);

  const parsed = await suggestAlternative({
    input: { service: 'Notion', planTier: 'Plus', annualCost: 96 },
    model,
    fetcher: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ stargazers_count: 61234, pushed_at: '2026-09-01T00:00:00Z' }),
      }),
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.suggestion.kind === 'alternative') {
    assert.equal(parsed.suggestion.value.repoHealth?.stars, 61234);
    assert.equal(parsed.suggestion.value.repoHealth?.lastCommit, '2026-09-01');
  }
});

/* ------------------------------------------------------------- the report */

function stored(overrides: Partial<StoredAlternative> = {}): StoredAlternative {
  return {
    service: 'Notion',
    normalizedName: 'NOTION LABS',
    annualCost: 96,
    alternative: 'AppFlowy',
    reason: 'Same documents-and-databases model.',
    noAlternativeCategory: null,
    repoUrl: 'https://github.com/AppFlowy-IO/AppFlowy',
    license: 'AGPL-3.0',
    selfHostRequired: false,
    migrationEffort: 'medium',
    annualSavings: 96,
    featuresLost: ['weaker mobile apps'],
    confidence: 'high',
    repoStars: 61234,
    repoLastCommit: '2026-09-01',
    repoStale: false,
    ...overrides,
  };
}

function row(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    service: 'Notion',
    annualCost: 96,
    amount: 8,
    currency: null,
    cadence: 'monthly',
    planTier: null,
    isTrial: false,
    nextRenewal: null,
    previousAmount: null,
    priceChangedOn: null,
    suggestion: null,
    traceDir: null,
    auditStatus: null,
    ...overrides,
  };
}

const NOW = new Date('2026-09-07T00:00:00Z');

test('the report totals spend and savings, and counts only real alternatives', () => {
  const markdown = renderReport(
    [
      row({ service: 'Notion', annualCost: 96, suggestion: stored() }),
      row({
        service: 'Amazon Prime',
        annualCost: 139,
        suggestion: stored({
          service: 'Amazon Prime',
          annualCost: 139,
          alternative: null,
          noAlternativeCategory: 'physical_logistics',
          reason: 'Physical delivery cannot be self-hosted.',
          annualSavings: null,
          license: null,
          repoUrl: null,
          featuresLost: [],
        }),
      }),
      row({ service: 'Spotify', annualCost: 120, suggestion: null }),
    ],
    NOW,
  );

  assert.match(markdown, /\*\*Total annual spend:\*\* 355\.00/);
  assert.match(markdown, /\*\*Plausible annual savings:\*\* 96\.00/);
  assert.match(markdown, /1 of 3 subscription\(s\) have a real alternative/);
  assert.match(markdown, /1 subscription\(s\) not yet checked/);

  assert.match(markdown, /\| Service \| Annual cost \| Alternative \| License \| Self-host \| Migration \| Savings \| Features lost \|/);
  assert.match(markdown, /\[AppFlowy\]\(https:\/\/github\.com\/AppFlowy-IO\/AppFlowy\)/);
  assert.match(markdown, /61,234★/);
  assert.match(markdown, /_none_/, 'the refusal is shown as a row, not hidden');
  assert.match(markdown, /_not checked_/);
  assert.match(markdown, /physical logistics/);
  assert.match(markdown, /never completes a/);

  assert.ok(!markdown.includes('## Needs attention'), 'no attention section when nothing needs it');
  assert.ok(!markdown.includes('## Upcoming renewals'), 'no renewals section without renewal dates');
});

test('a trial about to start charging is the first thing in the report', () => {
  const markdown = renderReport(
    [
      row({ service: 'Notion', annualCost: 96, suggestion: stored() }),
      row({
        service: 'Bear',
        annualCost: 29.99,
        amount: 29.99,
        currency: 'GBP',
        cadence: 'annual',
        planTier: 'Pro Yearly',
        isTrial: true,
        nextRenewal: '2026-10-01',
      }),
    ],
    NOW,
  );

  assert.match(markdown, /## Needs attention/);
  const attention = markdown.slice(markdown.indexOf('## Needs attention'));
  assert.match(attention, /\*\*Bear\*\* — free trial ends 2026-10-01, then GBP 29\.99 annual/);

  // and it is visible in the table too, for anyone who only scans that
  assert.match(markdown, /Bear.*— Pro Yearly \*\*\(trial\)\*\*/);
  assert.ok(
    markdown.indexOf('## Needs attention') < markdown.indexOf('## Subscriptions'),
    'what needs acting on comes before the full list',
  );
});

test('a price rise is called out with its size and date', () => {
  const markdown = renderReport(
    [
      row({
        service: 'Netflix',
        annualCost: 119.88,
        amount: 9.99,
        previousAmount: 4.99,
        priceChangedOn: '2026-01-07',
      }),
    ],
    NOW,
  );

  assert.match(markdown, /\*\*Netflix\*\* — price rose from 4\.99 to 9\.99 \(\+100%\) on 2026-01-07/);
  assert.match(markdown, /\| 119\.88 ↑ \|/, 'the table marks the row too');
});

test('a price cut is reported without being alarming', () => {
  const markdown = renderReport(
    [row({ service: 'Netflix', amount: 4.99, previousAmount: 9.99, priceChangedOn: '2026-01-07' })],
    NOW,
  );
  assert.match(markdown, /price fell from 9\.99 to 4\.99 on 2026-01-07/);
  assert.ok(!markdown.includes('↑'), 'a fall is not marked as a rise');
});

test('an audit that could not read the page is distinguished from one never run', () => {
  const markdown = renderReport(
    [
      row({ service: 'Notion', auditStatus: 'auth_expired', traceDir: 'traces/notion-1' }),
      row({ service: 'Spotify', auditStatus: 'extracted', traceDir: 'traces/spotify-1' }),
      row({ service: 'GitHub', auditStatus: null }),
    ],
    NOW,
  );

  assert.match(markdown, /\*\*Notion\*\* — billing page not read: the saved session had expired/);
  assert.ok(!markdown.includes('**Spotify** — billing page not read'), 'a successful audit is silent');
  assert.ok(!markdown.includes('**GitHub** — billing page not read'), 'never-audited is not a failure');
  assert.match(markdown, /\[GitHub\]|GitHub/);
});

test('known renewal dates become a forward calendar, past ones excluded', () => {
  const markdown = renderReport(
    [
      row({ service: 'Netflix', amount: 9.99, currency: 'GBP', nextRenewal: '2026-10-12' }),
      row({ service: 'Bear', amount: 29.99, currency: 'GBP', nextRenewal: '2026-09-20', isTrial: true }),
      row({ service: 'Stale', amount: 5, nextRenewal: '2026-01-01' }),
    ],
    NOW,
  );

  const section = markdown.slice(markdown.indexOf('## Upcoming renewals'), markdown.indexOf('## Subscriptions'));
  const dates = [...section.matchAll(/^\| (\d{4}-\d{2}-\d{2}) \|/gm)].map((match) => match[1]);
  assert.deepEqual(dates, ['2026-09-20', '2026-10-12'], 'soonest first, past dates dropped');
  assert.match(section, /Bear \(trial ends\)/);
});

test('an unmaintained project is flagged in the report', () => {
  const markdown = renderReport(
    [row({ suggestion: stored({ repoStale: true, repoLastCommit: '2023-02-11' }) })],
    NOW,
  );
  assert.match(markdown, /\*\*unmaintained since 2023-02-11\*\*/);
});

test('each row links to its trace directory', () => {
  const markdown = renderReport(
    [row({ suggestion: stored(), traceDir: 'traces/notion-2026-09-07' })],
    NOW,
  );
  assert.match(markdown, /\[Notion\]\(traces\/notion-2026-09-07\)/);
});

test('pipes and newlines in model text cannot break the table', () => {
  const markdown = renderReport(
    [
      row({
        service: 'Odd | Service',
        annualCost: 10,
        planTier: 'Tier | One',
        suggestion: stored({ featuresLost: ['a | b', 'multi\nline note'] }),
      }),
    ],
    NOW,
  );

  const body = markdown.slice(markdown.indexOf('## Subscriptions'));
  const tableLines = body.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| ---'));
  for (const line of tableLines) {
    const cells = line.split(/(?<!\\)\|/).length - 2;
    assert.equal(cells, 8, `every row has 8 cells: ${line}`);
  }
  assert.ok(!markdown.includes('multi\nline'), 'newlines are flattened');
});

/* -------------------------------------------------- storage  integration */

test('suggestions round-trip through the database into the report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerwalk-report-'));
  const dbPath = join(dir, 'ledgerwalk.db');
  const subsPath = join(dir, 'subscriptions.json');

  writeFileSync(
    subsPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      note: 'test',
      subscriptions: [
        {
          merchant: 'Notion Labs Inc SAN FRANCISCO CA',
          normalizedName: 'NOTION LABS',
          cadence: 'monthly',
          amount: 8,
          chargeCount: 7,
          firstSeen: '2024-01-22',
          lastSeen: '2024-07-22',
          annualCost: 96,
          confirmed: true,
          service: 'Notion',
        },
        {
          merchant: 'SAFEWAY #1234',
          normalizedName: 'SAFEWAY',
          cadence: 'monthly',
          amount: 40,
          chargeCount: 4,
          firstSeen: '2024-01-01',
          lastSeen: '2024-04-01',
          annualCost: 480,
          confirmed: false,
          service: null,
        },
      ],
    }),
    'utf8',
  );

  const db = openDb(dbPath);
  try {
    saveAudit(
      db,
      {
        service: 'Notion',
        goal: 'read billing',
        status: 'extracted',
        fields: { plan: 'Team', amount: '$96.00', cadence: 'yearly' },
        reason: 'found it',
        steps: 4,
        tokens: { input: 400, output: 40 },
        startedAt: '2026-09-07T10:00:00.000Z',
        finishedAt: '2026-09-07T10:01:00.000Z',
      },
      'traces/notion-2026-09-07',
    );

    const audit = latestAudit(db, 'notion');
    assert.equal(audit?.fields?.['plan'], 'Team', 'the plan tier feeds the phase 3 prompt');
    assert.equal(audit?.traceDir, 'traces/notion-2026-09-07');
    assert.equal(latestAudit(db, 'Nothing'), null);

    const model = new ScriptedModel([
      {
        tool: 'report_alternative',
        input: {
          alternative: 'AppFlowy',
          reason: 'Same documents-and-databases model.',
          repoUrl: 'https://github.com/AppFlowy-IO/AppFlowy',
          license: 'AGPL-3.0',
          selfHostRequired: false,
          migrationEffort: 'medium',
          annualSavings: 96,
          featuresLost: ['weaker mobile apps'],
          confidence: 'high',
        },
      },
    ]);

    const parsed = await suggestAlternative({
      input: { service: 'Notion', planTier: audit?.fields?.['plan'] ?? null, annualCost: 96 },
      model,
      verifyRepo: false,
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.suggestion.kind !== 'alternative') return;
    assert.match(model.lastPrompts[0] ?? '', /PLAN: Team/, 'the audited plan tier reaches the model');

    const value = parsed.suggestion.value;
    saveAlternative(db, {
      service: 'Notion',
      normalizedName: 'NOTION LABS',
      annualCost: 96,
      alternative: value.alternative,
      reason: value.reason,
      noAlternativeCategory: null,
      repoUrl: value.repoUrl,
      license: value.license,
      selfHostRequired: value.selfHostRequired,
      migrationEffort: value.migrationEffort,
      annualSavings: value.annualSavings,
      featuresLost: value.featuresLost,
      confidence: value.confidence,
      repoStars: 61234,
      repoLastCommit: '2026-09-01',
      repoStale: false,
    });

    const rows = buildRows(db, subsPath);
    assert.equal(rows.length, 1, 'an unconfirmed row is left out of the report');
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.service, 'Notion');
    assert.equal(row.traceDir, 'traces/notion-2026-09-07');
    assert.equal(row.suggestion?.alternative, 'AppFlowy');
    assert.deepEqual(row.suggestion?.featuresLost, ['weaker mobile apps']);

    const markdown = renderReport(rows, new Date('2026-09-07T00:00:00Z'));
    assert.match(markdown, /\*\*Total annual spend:\*\* 96\.00/);
    assert.match(markdown, /\[Notion\]\(traces\/notion-2026-09-07\)/);
    assert.match(markdown, /61,234★/);

    // Re-running replaces the previous suggestion rather than duplicating it.
    saveAlternative(db, {
      service: 'Notion',
      normalizedName: 'NOTION LABS',
      annualCost: 96,
      alternative: 'Outline',
      reason: 'Changed my mind.',
      noAlternativeCategory: null,
      repoUrl: null,
      license: 'BSL-1.1',
      selfHostRequired: true,
      migrationEffort: 'high',
      annualSavings: 50,
      featuresLost: [],
      confidence: 'medium',
      repoStars: null,
      repoLastCommit: null,
      repoStale: null,
    });
    const updated = buildRows(db, subsPath);
    assert.equal(updated.length, 1, 'still one row');
    assert.equal(updated[0]?.suggestion?.alternative, 'Outline');
  } finally {
    db.close();
  }
});
