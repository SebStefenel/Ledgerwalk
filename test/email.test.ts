import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { looksLikeReceipt, readFromDirectory, scrubBody } from '../src/stage1/mailbox.js';
import type { EmailMessage } from '../src/stage1/mailbox.js';
import {
  annualCostOf,
  dedupeSubscriptions,
  extractFromEmail,
  extractSubscriptions,
  parseReceipt,
} from '../src/stage1/receipts.js';
import type { ReceiptSubscription } from '../src/stage1/receipts.js';
import {
  loadConfirmed,
  mergeEmailFindings,
  mergeWithExisting,
  writeReviewFile,
} from '../src/stage1/review-file.js';
import { ScriptedModel } from './fixtures/scripted-model.js';

const EMAIL_DIR = fileURLToPath(new URL('./fixtures/emails', import.meta.url));

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: '<test@example.com>',
    subject: 'Your receipt',
    from: 'Vendor <no-reply@vendor.com>',
    date: '2026-03-02',
    body: 'Thanks for your payment.',
    ...overrides,
  };
}

/* --------------------------------------------------------------- mailbox */

test('the pre-filter keeps receipts and drops ordinary mail', () => {
  assert.equal(looksLikeReceipt('Your receipt from Apple.', 'Apple <no_reply@email.apple.com>'), true);
  assert.equal(looksLikeReceipt('Your Netflix payment receipt', 'info@mailer.netflix.com'), true);
  assert.equal(looksLikeReceipt('Your Figma Professional trial has started', 'noreply@figma.com'), true);
  assert.equal(looksLikeReceipt('Your subscription price is changing', 'x@y.com'), true);

  assert.equal(looksLikeReceipt('lunch tomorrow?', 'A Friend <friend@example.com>'), false);
  assert.equal(looksLikeReceipt('Re: the thing we discussed', 'colleague@work.com'), false);
});

test('card numbers never leave the machine', () => {
  const scrubbed = scrubBody('Payment method: Visa 4111 1111 1111 1111 ending soon');
  assert.ok(!scrubbed.includes('4111'), 'the card number is gone');
  assert.match(scrubbed, /\[CARD NUMBER REMOVED\]/);

  // Short numbers that carry real meaning are left alone.
  const kept = scrubBody('Card ending 4242, order 88213, GBP 9.99 on 2026-03-02');
  assert.match(kept, /4242/);
  assert.match(kept, /88213/);
  assert.match(kept, /9\.99/);
});

test('long bodies are truncated before they reach a model', () => {
  assert.equal(scrubBody('x'.repeat(10_000)).length, 4_000);
});

test('exported .eml files are read, including HTML-only ones', async () => {
  const { messages, warnings } = await readFromDirectory(EMAIL_DIR);
  assert.deepEqual(warnings, []);
  assert.equal(messages.length, 6);

  const apple = messages.find((item) => item.subject.includes('Apple'));
  assert.ok(apple !== undefined);
  assert.equal(apple.date, '2026-03-02');
  assert.match(apple.from, /no_reply@email\.apple\.com/);
  assert.match(apple.body, /HBO Max/);
  assert.ok(!apple.body.includes('4111'), 'scrubbing happens on read, not later');

  const spotify = messages.find((item) => item.subject.includes('Spotify'));
  assert.ok(spotify !== undefined);
  assert.match(spotify.body, /premium duo/i, 'HTML is converted to text');
  assert.match(spotify.body, /£16\.99/, 'entities are decoded');
  assert.ok(!spotify.body.includes('<h1>'), 'tags are stripped');
  assert.ok(!spotify.body.includes('var a=1'), 'scripts and styles are dropped');
  assert.match(spotify.body, /renews on 4 April 2026/);
});

test('an empty folder reports a warning rather than failing', async () => {
  const { messages, warnings } = await readFromDirectory(mkdtempSync(join(tmpdir(), 'ledgerwalk-empty-')));
  assert.equal(messages.length, 0);
  assert.match(warnings[0]?.message ?? '', /no \.eml files/);
});

/* -------------------------------------------------------------- parsing */

test('a bundled receipt yields one row per subscription', () => {
  const result = parseReceipt(
    {
      isReceipt: true,
      subscriptions: [
        { vendor: 'iCloud+', planTier: '200GB', amount: 2.99, currency: 'gbp', cadence: 'monthly',
          nextRenewal: '2026-04-02', isTrial: false, trialEndsOn: null },
        { vendor: 'HBO Max', planTier: 'Monthly', amount: 9.99, currency: 'GBP', cadence: 'monthly',
          nextRenewal: '2026-04-02', isTrial: false, trialEndsOn: null },
        { vendor: 'Bear', planTier: 'Pro Yearly', amount: 29.99, currency: 'GBP', cadence: 'yearly',
          nextRenewal: null, isTrial: true, trialEndsOn: '2026-10-01' },
      ],
    },
    message(),
  );

  assert.equal(result.isReceipt, true);
  assert.equal(result.subscriptions.length, 3);

  const bear = result.subscriptions[2];
  assert.equal(bear?.cadence, 'annual', '"yearly" is normalised');
  assert.equal(bear?.isTrial, true);
  assert.equal(bear?.trialEndsOn, '2026-10-01');
  assert.equal(result.subscriptions[0]?.currency, 'GBP', 'currency is upper-cased');
  assert.equal(result.subscriptions[0]?.normalizedName, 'ICLOUD');
  assert.equal(result.subscriptions[0]?.sourceMessageId, '<test@example.com>');
});

test('unusable rows are dropped without losing the good ones', () => {
  const result = parseReceipt(
    {
      isReceipt: true,
      subscriptions: [
        { vendor: 'Good', amount: 5, cadence: 'monthly', isTrial: false },
        { vendor: '', amount: 5, cadence: 'monthly', isTrial: false },
        { vendor: 'No amount', cadence: 'monthly', isTrial: false },
        { vendor: 'Bad cadence', amount: 5, cadence: 'fortnightly', isTrial: false },
        { vendor: 'Negative', amount: -5, cadence: 'monthly', isTrial: false },
        { vendor: 'Bad date', amount: 5, cadence: 'monthly', isTrial: false, nextRenewal: 'April 2026' },
        'not an object',
      ],
    },
    message(),
  );

  assert.deepEqual(
    result.subscriptions.map((item) => item.vendor),
    ['Good', 'Bad date'],
  );
  assert.equal(result.subscriptions[1]?.nextRenewal, null, 'an unparseable date becomes null');
});

test('a non-receipt yields nothing', () => {
  assert.deepEqual(parseReceipt({ isReceipt: false, subscriptions: [] }, message()), {
    isReceipt: false,
    subscriptions: [],
  });
  assert.deepEqual(parseReceipt('nonsense', message()).subscriptions, []);
});

test('annual cost is derived from the stated cadence', () => {
  assert.equal(annualCostOf(9.99, 'monthly'), 119.88);
  assert.equal(annualCostOf(29.99, 'annual'), 29.99);
  assert.equal(annualCostOf(5, 'weekly'), 260);
  assert.equal(annualCostOf(30, 'quarterly'), 120);
});

/* ------------------------------------------------------------ extracting */

test('the call teaches itemisation and rejection by example', async () => {
  const model = new ScriptedModel([
    {
      tool: 'report_receipt',
      input: {
        isReceipt: true,
        subscriptions: [
          { vendor: 'Netflix', planTier: 'Standard with ads', amount: 4.99, currency: 'GBP',
            cadence: 'monthly', nextRenewal: '2026-03-12', isTrial: false, trialEndsOn: null },
        ],
      },
    },
  ]);

  const result = await extractFromEmail(message({ subject: 'Your Netflix payment receipt' }), model);
  assert.equal(result.subscriptions.length, 1);
  assert.equal(result.subscriptions[0]?.vendor, 'Netflix');

  const call = model.calls[0];
  assert.ok(call !== undefined);
  const serialised = JSON.stringify(call.messages);

  // The bundled example is the entire point of this feature; assert it is taught.
  assert.match(serialised, /HBO Max/, 'the bundled example is present');
  assert.match(serialised, /iCloud/);
  assert.match(serialised, /Minecraft/, 'the one-off purchase is shown in the input');
  assert.ok(
    !/"vendor":"Minecraft"/.test(serialised),
    'and is deliberately absent from the worked answer',
  );
  assert.match(serialised, /"isReceipt":false/, 'the rejection example is present');

  assert.equal(call.messages.filter((entry) => entry.role === 'assistant').length, 2);
  assert.deepEqual(call.toolChoice, { type: 'tool', name: 'report_receipt' });
  assert.match(call.system, /ONE EMAIL CAN CONTAIN SEVERAL SUBSCRIPTIONS/);
  assert.match(call.system, /ONLY RECURRING CHARGES COUNT/);
});

test('every candidate is read, and one failure does not sink the batch', async () => {
  const good = {
    tool: 'report_receipt',
    input: {
      isReceipt: true,
      subscriptions: [{ vendor: 'Thing', amount: 1, cadence: 'monthly', isTrial: false }],
    },
  };

  let calls = 0;
  const model = new ScriptedModel([good]);
  const flaky = {
    tokens: model.tokens,
    send: (options: Parameters<typeof model.send>[0]) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('overloaded'));
      return model.send(options);
    },
  };

  const messages = [message({ subject: 'a' }), message({ subject: 'b' }), message({ subject: 'c' })];
  const result = await extractSubscriptions({ messages, model: flaky });

  assert.equal(result.subscriptions.length, 2, 'two of three succeeded');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]?.message ?? '', /overloaded/);
});

/* ---------------------------------------------------------------- dedupe */

function receipt(overrides: Partial<ReceiptSubscription> = {}): ReceiptSubscription {
  return {
    vendor: 'Netflix',
    normalizedName: 'NETFLIX',
    planTier: 'Standard',
    amount: 4.99,
    currency: 'GBP',
    cadence: 'monthly',
    nextRenewal: null,
    isTrial: false,
    trialEndsOn: null,
    sourceMessageId: '<a@b>',
    sourceSubject: 'receipt',
    seenOn: '2026-01-12',
    ...overrides,
  };
}

test('twelve monthly receipts collapse to the most recent one', () => {
  const monthly = ['2026-01-12', '2026-02-12', '2026-03-12'].map((seenOn) =>
    receipt({ seenOn, amount: seenOn === '2026-03-12' ? 5.99 : 4.99 }),
  );

  const deduped = dedupeSubscriptions(monthly);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.seenOn, '2026-03-12');
  assert.equal(deduped[0]?.amount, 5.99, 'the current price wins, not the oldest');
});

test('different plans of the same service stay separate, sorted by cost', () => {
  const deduped = dedupeSubscriptions([
    receipt({ vendor: 'Netflix', planTier: 'Standard', amount: 4.99 }),
    receipt({ vendor: 'Netflix', planTier: 'Premium', amount: 17.99 }),
    receipt({ vendor: 'Bear', normalizedName: 'BEAR', planTier: null, amount: 29.99, cadence: 'annual' }),
  ]);

  assert.deepEqual(
    deduped.map((item) => `${item.planTier ?? '-'}:${item.amount}`),
    ['Premium:17.99', 'Standard:4.99', '-:29.99'],
  );
});

/* --------------------------------------------------------------- merging */

test('email findings become new rows and enrich statement rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerwalk-merge-'));
  const path = join(dir, 'subscriptions.json');

  writeReviewFile(path, {
    generatedAt: '2026-03-01T00:00:00Z',
    note: 'test',
    subscriptions: [
      {
        merchant: 'NETFLIX.COM 8667797',
        normalizedName: 'NETFLIX',
        cadence: 'monthly',
        amount: 4.99,
        chargeCount: 9,
        firstSeen: '2025-06-12',
        lastSeen: '2026-02-12',
        annualCost: 59.88,
        confirmed: true,
        service: 'Netflix',
        discoveredBy: 'statement',
        planTier: null,
        currency: null,
        nextRenewal: null,
        isTrial: false,
      },
    ],
  });

  const merged = mergeEmailFindings(
    [
      receipt({ planTier: 'Standard with ads', nextRenewal: '2026-03-12', amount: 9.99, seenOn: '2026-03-12' }),
      receipt({
        vendor: 'HBO Max',
        normalizedName: 'HBO MAX',
        planTier: 'Monthly',
        amount: 9.99,
        nextRenewal: '2026-04-02',
        seenOn: '2026-03-02',
      }),
    ],
    path,
  );
  writeReviewFile(path, merged);

  const rows = loadConfirmed(path);
  assert.equal(rows.length, 2);

  const netflix = rows.find((row) => row.normalizedName === 'NETFLIX');
  assert.equal(netflix?.planTier, 'Standard with ads', 'the receipt supplies what a bank line cannot');
  assert.equal(netflix?.nextRenewal, '2026-03-12');
  assert.equal(netflix?.currency, 'GBP');
  assert.equal(netflix?.discoveredBy, 'statement');
  assert.equal(netflix?.amount, 4.99, 'the statement keeps authority over what was actually charged');
  assert.equal(netflix?.annualCost, 59.88);
  assert.equal(netflix?.service, 'Netflix', 'hand edits survive');

  const hbo = rows.find((row) => row.normalizedName === 'HBO MAX');
  assert.equal(hbo?.discoveredBy, 'email');
  assert.equal(hbo?.annualCost, 119.88);
  assert.equal(hbo?.chargeCount, 1);
});

test('a statement scan never deletes rows that only email could find', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerwalk-keep-'));
  const path = join(dir, 'subscriptions.json');

  writeReviewFile(path, mergeEmailFindings([receipt({ vendor: 'HBO Max', normalizedName: 'HBO MAX' })], path));

  // A later statement scan finds a different service entirely.
  const after = mergeWithExisting(
    [
      {
        merchant: 'SPOTIFY*P1A2B3',
        normalizedName: 'SPOTIFY',
        cadence: 'monthly',
        amount: 10.99,
        chargeCount: 12,
        firstSeen: '2025-01-14',
        lastSeen: '2025-12-11',
        annualCost: 131.88,
        charges: [],
      },
    ],
    path,
  );
  writeReviewFile(path, after);

  const names = loadConfirmed(path).map((row) => row.normalizedName).sort();
  assert.deepEqual(names, ['HBO MAX', 'SPOTIFY'], 'the email-only row survived the scan');
});

test('a review file written by an older version still loads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerwalk-old-'));
  const path = join(dir, 'subscriptions.json');

  // No discoveredBy, planTier, currency, nextRenewal or isTrial.
  writeFileSync(
    path,
    JSON.stringify({
      generatedAt: '2026-01-01T00:00:00Z',
      note: 'old',
      subscriptions: [
        {
          merchant: 'SPOTIFY*P1A2B3',
          normalizedName: 'SPOTIFY',
          cadence: 'monthly',
          amount: 10.99,
          chargeCount: 12,
          firstSeen: '2025-01-14',
          lastSeen: '2025-12-11',
          annualCost: 131.88,
          confirmed: true,
          service: null,
        },
      ],
    }),
    'utf8',
  );

  const rows = loadConfirmed(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.discoveredBy, 'statement', 'defaults are filled in');
  assert.equal(rows[0]?.isTrial, false);
  assert.equal(rows[0]?.planTier, null);
  assert.equal(rows[0]?.annualCost, 131.88);
});
