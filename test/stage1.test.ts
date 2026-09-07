import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  detectDateOrder,
  detectRecurring,
  mapHeaders,
  normalizeMerchant,
  parseAmount,
  parseDate,
  parseStatements,
} from '../src/stage1/parse-statements.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('header mapping copes with varied casing and split debit/credit columns', () => {
  const single = mapHeaders(['Transaction Date', 'Post Date', 'Description', 'Category', 'Amount']);
  assert.equal(single?.date, 'Transaction Date');
  assert.equal(single?.description, 'Description');
  assert.equal(single?.amount, 'Amount');

  const split = mapHeaders(['DATE', 'NARRATIVE', 'DEBIT', 'CREDIT', 'BALANCE']);
  assert.equal(split?.debit, 'DEBIT');
  assert.equal(split?.credit, 'CREDIT');
  assert.equal(split?.amount, null);

  assert.equal(mapHeaders(['Account: ****5678', '', '']), null, 'preamble row is not a header');
});

test('amounts parse across currency, sign and locale conventions', () => {
  assert.equal(parseAmount('-10.99'), -10.99);
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount('(42.00)'), -42);
  assert.equal(parseAmount('19,97'), 19.97, 'comma decimal');
  assert.equal(parseAmount('1.234,56'), 1234.56, 'european thousands + decimal');
  assert.equal(parseAmount('55.00 CR'), -55, 'credit marker flips the sign');
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('  '), null);
});

test('date order is decided per column, not per cell', () => {
  assert.equal(detectDateOrder(['01/02/2024', '18/03/2024']), 'dmy');
  assert.equal(detectDateOrder(['01/02/2024', '03/18/2024']), 'mdy');
  assert.equal(detectDateOrder(['2024-03-18']), 'iso');

  assert.equal(parseDate('18/03/2024', 'dmy'), '2024-03-18');
  assert.equal(parseDate('03/18/2024', 'mdy'), '2024-03-18');
  assert.equal(parseDate('Jan 12, 2024', 'text'), '2024-01-12');
  assert.equal(parseDate('31/02/2024', 'dmy'), null, 'rejects impossible dates');
});

test('merchant normalisation collapses statement spellings onto one key', () => {
  assert.equal(normalizeMerchant('SPOTIFY*P1A2B3'), 'SPOTIFY');
  assert.equal(normalizeMerchant('SQ *BLUE BOTTLE COFFEE OAKLAND CA'), 'BLUE BOTTLE COFFEE');
  assert.equal(normalizeMerchant('Notion Labs Inc SAN FRANCISCO CA'), 'NOTION LABS');
  assert.equal(normalizeMerchant('NETFLIX.COM 8667797'), 'NETFLIX');
  assert.equal(normalizeMerchant('GITHUB.COM HELP.GITHUB.COM GB'), 'GITHUB');
  assert.equal(normalizeMerchant('Amazon Prime Membership #4471'), 'AMAZON PRIME');
  assert.equal(
    normalizeMerchant('RECURRING PAYMENT AUTHORIZED ON 03/14 ADOBE *CREATIVE CLOUD'),
    normalizeMerchant('ADOBE *CREATIVE CLOUD'),
    'transaction-type noise does not split a group',
  );
});

test('recurring detection finds subscriptions and ignores everyday spending', () => {
  const { charges } = parseStatements([fixture('us-card.csv'), fixture('uk-bank.csv')]);
  const found = detectRecurring(charges);
  const names = found.map((sub) => sub.normalizedName);

  assert.deepEqual(
    [...names].sort(),
    ['ADOBE', 'AMAZON PRIME', 'GITHUB', 'NETFLIX', 'NOTION LABS', 'SPOTIFY'],
  );
  for (const noise of ['SAFEWAY', 'SHELL OIL', 'TESCO STORES', 'BLUE BOTTLE COFFEE']) {
    assert.ok(!names.includes(noise), `${noise} must not be flagged as recurring`);
  }

  const spotify = found.find((sub) => sub.normalizedName === 'SPOTIFY');
  assert.equal(spotify?.cadence, 'monthly');
  assert.equal(spotify?.amount, 10.99);
  assert.equal(spotify?.chargeCount, 12);
  assert.equal(spotify?.annualCost, 131.88);

  const prime = found.find((sub) => sub.normalizedName === 'AMAZON PRIME');
  assert.equal(prime?.cadence, 'annual');
  assert.equal(prime?.annualCost, 139);

  assert.deepEqual(
    found.map((sub) => sub.annualCost),
    [...found.map((sub) => sub.annualCost)].sort((a, b) => b - a),
    'results are ordered by annual cost',
  );
});

test('income and refunds are never treated as charges', () => {
  const { charges } = parseStatements([fixture('uk-bank.csv')]);
  assert.ok(!charges.some((charge) => charge.description.includes('SALARY')));
});
