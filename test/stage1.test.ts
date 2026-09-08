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
  priceChange,
  segmentPriceBands,
} from '../src/stage1/parse-statements.js';
import type { Charge } from '../src/stage1/parse-statements.js';

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

/* --------------------------------------------------- price change tracking */

/** Monthly charges starting 2025-01-12, one per 30 days, at the given prices. */
function monthly(prices: readonly number[], description = 'NETFLIX.COM 8667797'): Charge[] {
  let day = new Date('2025-01-12T00:00:00Z');
  return prices.map((amount) => {
    const date = day.toISOString().slice(0, 10);
    day = new Date(day.getTime() + 30 * 86_400_000);
    return { date, description, amount, sourceFile: 'test.csv' };
  });
}

const repeat = (count: number, value: number): number[] => Array.from({ length: count }, () => value);

test('a price rise is reported at the new price, not the old one', () => {
  // Regression: charges outside one price band used to be discarded, so this
  // reported 4.99 with a last-seen date six months stale and half the real cost.
  const [found] = detectRecurring(monthly([...repeat(12, 4.99), ...repeat(6, 9.99)]));
  assert.ok(found !== undefined, 'still detected as recurring');

  assert.equal(found.amount, 9.99, 'the current price, not the historical one');
  assert.equal(found.annualCost, 119.88);
  assert.equal(found.chargeCount, 18, 'no charges are thrown away');
  assert.equal(found.lastSeen, '2026-06-06', 'last seen is the newest charge, not the newest cheap one');
  assert.equal(found.previousAmount, 4.99);
  assert.equal(found.priceChangedOn, '2026-01-07');
  assert.deepEqual(
    found.priceHistory.map((point) => `${point.amount}x${point.count}`),
    ['4.99x12', '9.99x6'],
  );
});

test('a rise on the most recent charge is caught immediately', () => {
  const [found] = detectRecurring(monthly([...repeat(12, 4.99), 9.99]));
  assert.equal(found?.amount, 9.99, 'one charge at the new price is enough to report it');
  assert.equal(found?.previousAmount, 4.99);
});

test('several rises over the years are all kept', () => {
  const [found] = detectRecurring(
    monthly([...repeat(12, 4.99), ...repeat(12, 6.99), ...repeat(12, 9.99)]),
  );
  assert.equal(found?.amount, 9.99);
  assert.equal(found?.chargeCount, 36);
  assert.equal(found?.previousAmount, 6.99, 'compared against the price just before, not the first');
  assert.deepEqual(found?.priceHistory.map((point) => point.amount), [4.99, 6.99, 9.99]);
});

test('a one-off purchase from the same merchant is not a price change', () => {
  const [found] = detectRecurring(monthly([...repeat(5, 4.99), 60, ...repeat(6, 4.99)]));
  assert.equal(found?.amount, 4.99, 'the stray does not become the current price');
  assert.equal(found?.previousAmount, null, 'and it is not reported as a rise');
  assert.equal(found?.priceChangedOn, null);
});

test('variable-amount merchants are still rejected', () => {
  // The old 10% band did double duty: it also kept shops out. The band-count
  // rule has to hold that line now that charges are no longer discarded.
  assert.deepEqual(detectRecurring(monthly([12.4, 88.1, 5.2, 43.9, 61, 9.75, 30.2, 51.4], 'TESCO')), []);
  assert.deepEqual(detectRecurring(monthly([20, 45, 12], 'SAFEWAY')), []);
});

test('price bands are cut where the amount changes, in date order', () => {
  const bands = segmentPriceBands(monthly([4.99, 4.99, 5.2, 9.99, 9.99]));
  assert.deepEqual(
    bands.map((band) => ({ amount: band.amount, count: band.count })),
    [
      { amount: 4.99, count: 3 },
      { amount: 9.99, count: 2 },
    ],
    '5.20 is within 10% of 4.99, so it extends that band rather than starting one',
  );
  assert.equal(bands[0]?.from, '2025-01-12');
  assert.equal(bands[1]?.from, '2025-04-12');
  assert.deepEqual(segmentPriceBands([]), []);
});

test('price change ignores single-charge bands part-way through', () => {
  assert.equal(
    priceChange([
      { amount: 4.99, from: '2025-01-01', to: '2025-05-01', count: 5 },
      { amount: 60, from: '2025-06-01', to: '2025-06-01', count: 1 },
      { amount: 4.99, from: '2025-07-01', to: '2025-12-01', count: 6 },
    ]),
    null,
  );

  assert.deepEqual(
    priceChange([
      { amount: 4.99, from: '2025-01-01', to: '2025-12-01', count: 12 },
      { amount: 9.99, from: '2026-01-01', to: '2026-06-01', count: 6 },
    ]),
    { previousAmount: 4.99, changedOn: '2026-01-01' },
  );

  assert.equal(priceChange([{ amount: 4.99, from: 'a', to: 'b', count: 3 }]), null);
  assert.equal(priceChange([]), null);
});
