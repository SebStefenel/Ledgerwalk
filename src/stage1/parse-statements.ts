import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/* ------------------------------------------------------------------ types */

export type Cadence = 'monthly' | 'annual';

export interface Charge {
  /** ISO yyyy-mm-dd */
  readonly date: string;
  /** original statement description, untouched */
  readonly description: string;
  /** positive magnitude of money leaving the account */
  readonly amount: number;
  readonly sourceFile: string;
}

/** A stretch of consecutive charges at one price. */
export interface PricePoint {
  readonly amount: number;
  /** first charge date at this price */
  readonly from: string;
  /** last charge date at this price */
  readonly to: string;
  readonly count: number;
}

export interface DetectedSubscription {
  /** most representative raw description seen for this group */
  readonly merchant: string;
  readonly normalizedName: string;
  readonly cadence: Cadence;
  /** the CURRENT price: the median of the most recent price band */
  readonly amount: number;
  readonly chargeCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** derived from the current price, so a price rise is reflected immediately */
  readonly annualCost: number;
  /** every price this subscription has been charged at, oldest first */
  readonly priceHistory: readonly PricePoint[];
  /** the last materially different price, when there was one */
  readonly previousAmount: number | null;
  /** date of the first charge at the current price */
  readonly priceChangedOn: string | null;
  readonly charges: readonly Charge[];
}

export interface HeaderMap {
  readonly date: string;
  readonly description: string;
  /** single signed amount column, when the bank uses one */
  readonly amount: string | null;
  /** split money-out / money-in columns, when the bank uses those instead */
  readonly debit: string | null;
  readonly credit: string | null;
}

export interface ParseWarning {
  readonly file: string;
  readonly message: string;
}

export interface ParseResult {
  readonly charges: readonly Charge[];
  readonly warnings: readonly ParseWarning[];
}

/* ------------------------------------------------------- header detection */

/** Lowercase and drop everything that is not a letter or digit, so
 *  "Transaction Date", "TRANSACTION_DATE" and "transaction-date" all collapse
 *  to the same token. */
function slug(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Ordered patterns — earlier entries win, so "transactiondate" beats a bare
 *  "postdate" when a statement carries both. */
const DATE_PATTERNS: readonly RegExp[] = [
  /^trans(action)?date$/,
  /^date$/,
  /^(posted?|posting|booking|value|effective)date$/,
  /date/,
];

const DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /^(description|details|narrative|memo|payee|merchant|particulars)$/,
  /^transactiondescription$/,
  /desc|detail|narrat|memo|payee|merchant|particular|reference|vendor/,
  /^name$/,
];

const AMOUNT_PATTERNS: readonly RegExp[] = [
  /^amount$/,
  /^(transaction|billing|local)amount$/,
  /^amount[a-z]*$/,
  /amount|value/,
];

const DEBIT_PATTERNS: readonly RegExp[] = [/^debit$/, /debit|withdrawal|moneyout|paidout|outflow/];
const CREDIT_PATTERNS: readonly RegExp[] = [/^credit$/, /credit|deposit|moneyin|paidin|inflow/];

function pick(headers: readonly string[], patterns: readonly RegExp[], taken: ReadonlySet<string>): string | null {
  for (const pattern of patterns) {
    for (const header of headers) {
      if (taken.has(header)) continue;
      if (pattern.test(slug(header))) return header;
    }
  }
  return null;
}

/**
 * Map a header row onto the four roles we care about. Returns null when the row
 * plainly is not a header (which is how we skip the preamble blurb that many
 * banks put above their real header row).
 */
export function mapHeaders(headers: readonly string[]): HeaderMap | null {
  const taken = new Set<string>();

  const date = pick(headers, DATE_PATTERNS, taken);
  if (date !== null) taken.add(date);

  // Claim debit/credit before description so a "Debit" column is never mistaken
  // for a text field, and before amount so "Debit Amount" resolves correctly.
  const debit = pick(headers, DEBIT_PATTERNS, taken);
  if (debit !== null) taken.add(debit);
  const credit = pick(headers, CREDIT_PATTERNS, taken);
  if (credit !== null) taken.add(credit);

  const amount = pick(headers, AMOUNT_PATTERNS, taken);
  if (amount !== null) taken.add(amount);

  const description = pick(headers, DESCRIPTION_PATTERNS, taken);

  if (date === null || description === null) return null;
  if (amount === null && debit === null) return null;

  return { date, description, amount, debit, credit };
}

/* -------------------------------------------------------- value  parsing */

/**
 * Parse a statement amount into a signed number. Handles currency symbols,
 * thousands separators, accounting parentheses for negatives, trailing CR/DR
 * markers, and comma-decimal locales.
 */
export function parseAmount(raw: string): number | null {
  let text = raw.trim();
  if (text === '') return null;

  let sign = 1;

  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }

  const marker = /\b(CR|DR)\b\s*$/i.exec(text);
  if (marker !== null) {
    if ((marker[1] ?? '').toUpperCase() === 'CR') sign *= -1;
    text = text.slice(0, marker.index);
  }

  text = text.replace(/[^\d,.\-+]/g, '');

  if (text.startsWith('-')) {
    sign *= -1;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  text = text.replace(/[-+]/g, '');

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever separator comes last is the decimal point.
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // A lone comma is decimal only when exactly two digits follow it.
    text = /,\d{2}$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');
  }

  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? sign * value : null;
}

type DateOrder = 'iso' | 'dmy' | 'mdy' | 'text';

const NUMERIC_DATE = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})$/;

/**
 * Decide the date format once per column rather than per cell. 03/04 is
 * genuinely ambiguous in isolation; across a whole statement some row almost
 * always disambiguates it.
 */
export function detectDateOrder(values: readonly string[]): DateOrder {
  let numeric = 0;
  let firstOverTwelve = 0;
  let secondOverTwelve = 0;

  for (const value of values) {
    const match = NUMERIC_DATE.exec(value.trim());
    if (match === null) continue;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (String(match[1]).length === 4) return 'iso';
    numeric += 1;
    if (a > 12) firstOverTwelve += 1;
    if (b > 12) secondOverTwelve += 1;
  }

  if (numeric === 0) return 'text';
  if (firstOverTwelve > secondOverTwelve) return 'dmy';
  if (secondOverTwelve > firstOverTwelve) return 'mdy';
  return 'mdy'; // no evidence either way: assume US ordering
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const stamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(stamp)) return null;
  const date = new Date(stamp);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function parseDate(raw: string, order: DateOrder): string | null {
  const text = raw.trim();
  if (text === '') return null;

  const match = NUMERIC_DATE.exec(text);
  if (match !== null) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const c = Number(match[3]);
    if (String(match[1]).length === 4) return iso(a, b, c);
    const year = c < 100 ? 2000 + c : c;
    return order === 'dmy' ? iso(year, b, a) : iso(year, a, b);
  }

  // "12 Jan 2024", "Jan 12, 2024", "2024-01-12T00:00:00Z"
  const stamp = Date.parse(text);
  if (Number.isFinite(stamp)) return new Date(stamp).toISOString().slice(0, 10);
  return null;
}

/* --------------------------------------------------- merchant  normalising */

/** Payment aggregators that prefix the real merchant, as in `SQ *BLUE BOTTLE`. */
const AGGREGATOR_PREFIXES = new Set([
  'SQ', 'TST', 'SP', 'PP', 'PAYPAL', 'PY', 'EB', 'WL', 'IN', 'DRI', 'FS', 'LEVELUP', 'TSQ', 'CKE',
]);

/** Transaction-type noise banks staple to the front of a description. */
const LEADING_NOISE =
  /^(recurring (payment|charge|debit)|preauthorized (debit|payment)|(purchase )?authorized on \d{1,2}[/-]\d{1,2}|debit card (purchase|payment)|card (purchase|payment)|pos (purchase|debit)?|point of sale|ach (debit|payment|web)?|electronic (payment|withdrawal)|online (payment|purchase)|visa|mastercard|amex|checkcard|ckcd|payment to|autopay)\s+/i;

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
  'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA',
  'RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','AB','BC','ON','QC',
]);

const COUNTRY_CODES = new Set(['US', 'USA', 'GB', 'GBR', 'UK', 'CAN', 'IE', 'IRL', 'NL', 'DE', 'FR', 'AU', 'NZ']);

/** Leading words of common two-word city names, so "SAN FRANCISCO CA" is peeled
 *  whole rather than leaving a stray "SAN" glued to the merchant. */
const CITY_PREFIX_WORDS = new Set([
  'SAN', 'LOS', 'LAS', 'NEW', 'FORT', 'FT', 'SAINT', 'ST', 'PORT', 'WEST', 'EAST', 'NORTH',
  'SOUTH', 'MOUNT', 'MT', 'LAKE', 'SANTA', 'EL', 'DES', 'SALT',
]);

const CORPORATE_SUFFIXES = new Set([
  'INC', 'INCORPORATED', 'LLC', 'LLP', 'LP', 'LTD', 'LIMITED', 'CORP', 'CORPORATION', 'CO',
  'PLC', 'GMBH', 'BV', 'NV', 'AB', 'AS', 'SA', 'SAS', 'SRL', 'PTY', 'PTE',
]);

/**
 * Collapse the many statement spellings of one merchant onto a single grouping
 * key: `SPOTIFY*P1A2B3`, `SPOTIFY USA 8774`, `Spotify #1234 NEW YORK NY` all
 * become `SPOTIFY`.
 */
export function normalizeMerchant(description: string): string {
  let text = description.toUpperCase().trim();

  while (LEADING_NOISE.test(text)) text = text.replace(LEADING_NOISE, '').trim();

  // Aggregator stars: keep the segment that names the actual merchant.
  if (text.includes('*')) {
    const segments = text.split('*').map((segment) => segment.trim()).filter((segment) => segment !== '');
    const head = segments[0] ?? '';
    const rest = segments[1];
    const headIsPrefix = AGGREGATOR_PREFIXES.has(head.replace(/[^A-Z]/g, '')) || head.length <= 3;
    text = headIsPrefix && rest !== undefined ? rest : head;
  }

  text = text.replace(/\.(COM|CO\.UK|NET|ORG|IO|CO)\b/g, ' ');
  text = text.replace(/[^A-Z0-9 &]/g, ' ').replace(/\s+/g, ' ').trim();

  // Drop repeated tokens, keeping first use: "GITHUB HELP GITHUB" -> "GITHUB HELP".
  // Card descriptors that name a site and then its support domain are common.
  const seenTokens = new Set<string>();
  text = text
    .split(' ')
    .filter((token) => {
      if (token === '' || seenTokens.has(token)) return false;
      seenTokens.add(token);
      return true;
    })
    .join(' ');

  // Peel trailing location / reference junk until nothing changes.
  for (let pass = 0; pass < 8; pass += 1) {
    const before = text;
    const tokens = text.split(' ').filter((token) => token !== '');
    const last = tokens[tokens.length - 1];
    if (last === undefined || tokens.length <= 1) break;

    if (US_STATES.has(last) && tokens.length >= 3) {
      // "MERCHANT CITY ST" — a state code implies the tokens before it are a city.
      // Checked ahead of COUNTRY_CODES because a trailing CA on a card descriptor
      // is California far more often than Canada.
      let keep = tokens.length - 2;
      const cityPrefix = tokens[keep - 1];
      if (keep >= 2 && cityPrefix !== undefined && CITY_PREFIX_WORDS.has(cityPrefix)) keep -= 1;
      text = tokens.slice(0, keep).join(' ');
    } else if (COUNTRY_CODES.has(last)) {
      text = tokens.slice(0, -1).join(' ');
    } else if (/^\d+$/.test(last) || /^[A-Z]?\d[A-Z0-9]{2,}$/.test(last)) {
      // store numbers, phone fragments, and reference ids like P1A2B3
      text = tokens.slice(0, -1).join(' ');
    } else if (CORPORATE_SUFFIXES.has(last) && tokens.length >= 2) {
      text = tokens.slice(0, -1).join(' ');
    } else if (/^(RECURRING|AUTOPAY|SUBSCRIPTION|SUBSCR|MEMBERSHIP|MONTHLY|ANNUAL|PAYMENT|BILL|HELP|SUPPORT|ONLINE)$/.test(last)) {
      text = tokens.slice(0, -1).join(' ');
    }

    if (text === before) break;
  }

  text = text.replace(/\s+/g, ' ').trim();
  return text === '' ? description.toUpperCase().trim() : text;
}

/* ------------------------------------------------------------ csv reading */

type RawRecord = Readonly<Record<string, string>>;

/**
 * Find the header row. Many exports carry an account-summary preamble above it,
 * so try each of the first rows as a header and keep the first that maps.
 */
function locateHeader(rows: readonly (readonly string[])[]): { index: number; map: HeaderMap } | null {
  const limit = Math.min(rows.length, 15);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const map = mapHeaders(row.map((cell) => cell.trim()));
    if (map !== null) return { index, map };
  }
  return null;
}

export function parseStatementFile(path: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const file = basename(path);
  const text = readFileSync(path, 'utf8');

  const grid = parse(text, {
    bom: true,
    relaxColumnCount: true,
    relaxQuotes: true,
    skipEmptyLines: true,
    trim: true,
  }) as string[][];

  const header = locateHeader(grid);
  if (header === null) {
    return {
      charges: [],
      warnings: [{ file, message: 'no recognisable date/description/amount header row found' }],
    };
  }

  const records = parse(text, {
    bom: true,
    columns: true,
    fromLine: header.index + 1,
    relaxColumnCount: true,
    relaxQuotes: true,
    skipEmptyLines: true,
    trim: true,
  }) as RawRecord[];

  const map = header.map;
  const order = detectDateOrder(records.map((record) => record[map.date] ?? ''));

  // Establish the sign convention for a single-amount column: whichever sign is
  // in the majority is the spending direction for this statement.
  let negatives = 0;
  let positives = 0;
  if (map.amount !== null) {
    for (const record of records) {
      const value = parseAmount(record[map.amount] ?? '');
      if (value === null || value === 0) continue;
      if (value < 0) negatives += 1;
      else positives += 1;
    }
  }
  const outflowIsNegative = negatives >= positives;

  const charges: Charge[] = [];
  let skipped = 0;

  for (const record of records) {
    const description = (record[map.description] ?? '').trim();
    const date = parseDate(record[map.date] ?? '', order);
    if (date === null || description === '') {
      skipped += 1;
      continue;
    }

    let outflow: number | null = null;
    if (map.amount !== null) {
      const value = parseAmount(record[map.amount] ?? '');
      if (value !== null && value !== 0) {
        const isOutflow = outflowIsNegative ? value < 0 : value > 0;
        if (isOutflow) outflow = Math.abs(value);
      }
    } else if (map.debit !== null) {
      const value = parseAmount(record[map.debit] ?? '');
      if (value !== null && value !== 0) outflow = Math.abs(value);
    }

    if (outflow === null) continue; // credit / refund / zero row — not a charge
    charges.push({ date, description, amount: outflow, sourceFile: file });
  }

  if (skipped > 0) warnings.push({ file, message: `${skipped} row(s) skipped: unparseable date or empty description` });
  if (charges.length === 0) warnings.push({ file, message: 'no outgoing charges found' });

  return { charges, warnings };
}

export function parseStatements(paths: readonly string[]): ParseResult {
  const charges: Charge[] = [];
  const warnings: ParseWarning[] = [];
  for (const path of paths) {
    const result = parseStatementFile(path);
    charges.push(...result.charges);
    warnings.push(...result.warnings);
  }
  return { charges, warnings };
}

/* ------------------------------------------------------ recurrence  detection */

/** Two charges count as "the same price" when they are within this of each other. */
const AMOUNT_TOLERANCE = 0.1;

/**
 * Average charges per price band required to believe a group is a subscription.
 *
 * This is what separates a subscription from a shop. A subscription holds one
 * price for several billing cycles and then steps to a new one, so a long
 * history collapses into a handful of bands. A supermarket charges a different
 * amount nearly every time, so its bands are almost all single charges and the
 * group is rejected.
 */
const MIN_CHARGES_PER_BAND = 3;

/** Strict windows from the spec, matched against the *median* gap. */
const CADENCE_WINDOWS: Readonly<Record<Cadence, readonly [number, number]>> = {
  monthly: [28, 31],
  annual: [360, 370],
};

/** Wider bands used only for the "most gaps agree" sanity check, so one late
 *  bank posting does not disqualify an otherwise obvious subscription. */
const CADENCE_TOLERANT: Readonly<Record<Cadence, readonly [number, number]>> = {
  monthly: [25, 35],
  annual: [345, 385],
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function daysBetween(a: string, b: string): number {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function classify(gaps: readonly number[]): Cadence | null {
  if (gaps.length === 0) return null;
  const typical = median(gaps);

  for (const cadence of ['monthly', 'annual'] as const) {
    const [low, high] = CADENCE_WINDOWS[cadence];
    if (typical < low || typical > high) continue;
    const [tolerantLow, tolerantHigh] = CADENCE_TOLERANT[cadence];
    const agreeing = gaps.filter((gap) => gap >= tolerantLow && gap <= tolerantHigh).length;
    if (agreeing * 2 > gaps.length) return cadence;
  }
  return null;
}

/** Drop rows that repeat across overlapping statement exports. */
function dedupe(charges: readonly Charge[]): Charge[] {
  const seen = new Set<string>();
  const out: Charge[] = [];
  for (const charge of charges) {
    const key = `${charge.date}|${charge.amount.toFixed(2)}|${charge.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(charge);
  }
  return out;
}

/** The description that best represents the group: most frequent, then shortest. */
function representativeName(charges: readonly Charge[]): string {
  const counts = new Map<string, number>();
  for (const charge of charges) counts.set(charge.description, (counts.get(charge.description) ?? 0) + 1);
  let best = charges[0]?.description ?? '';
  let bestCount = -1;
  for (const [description, count] of counts) {
    if (count > bestCount || (count === bestCount && description.length < best.length)) {
      best = description;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Walk the charges in date order and cut a new band whenever the amount stops
 * matching the band it is in. Returns bands oldest first, so the last one is
 * what the subscription costs today.
 */
export function segmentPriceBands(sortedByDate: readonly Charge[]): PricePoint[] {
  interface Band {
    amounts: number[];
    from: string;
    to: string;
  }
  const bands: Band[] = [];

  for (const charge of sortedByDate) {
    const current = bands[bands.length - 1];
    if (current !== undefined) {
      const representative = median(current.amounts);
      if (
        representative > 0 &&
        Math.abs(charge.amount - representative) <= AMOUNT_TOLERANCE * representative
      ) {
        current.amounts.push(charge.amount);
        current.to = charge.date;
        continue;
      }
    }
    bands.push({ amounts: [charge.amount], from: charge.date, to: charge.date });
  }

  return bands.map((band) => ({
    amount: Math.round(median(band.amounts) * 100) / 100,
    from: band.from,
    to: band.to,
    count: band.amounts.length,
  }));
}

/**
 * The last price that genuinely differs from today's.
 *
 * Single-charge bands part-way through a history are skipped: a one-off purchase
 * from the same merchant is not a price change, and reporting it as one would be
 * worse than saying nothing.
 */
export function priceChange(
  bands: readonly PricePoint[],
): { readonly previousAmount: number; readonly changedOn: string } | null {
  const current = bands[bands.length - 1];
  if (current === undefined) return null;

  for (let index = bands.length - 2; index >= 0; index -= 1) {
    const band = bands[index];
    if (band === undefined || band.count < 2) continue;
    if (Math.abs(band.amount - current.amount) <= AMOUNT_TOLERANCE * current.amount) return null;
    return { previousAmount: band.amount, changedOn: current.from };
  }
  return null;
}

/**
 * Group charges by fuzzy merchant name and keep the groups that look like a
 * subscription: at least three charges at a monthly or annual rhythm, holding a
 * steady price between occasional changes. Result is sorted by inferred annual
 * cost (at today's price), largest first.
 */
export function detectRecurring(charges: readonly Charge[]): DetectedSubscription[] {
  const groups = new Map<string, Charge[]>();
  for (const charge of dedupe(charges)) {
    const key = normalizeMerchant(charge.description);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [charge]);
    else bucket.push(charge);
  }

  const found: DetectedSubscription[] = [];

  for (const [normalizedName, bucket] of groups) {
    if (bucket.length < 3) continue;

    const sorted = [...bucket].sort((a, b) => a.date.localeCompare(b.date));

    // Split the history into consecutive price bands rather than discarding
    // everything outside one band. A subscription whose price rose is still one
    // subscription — dropping the newer, dearer charges would report a price you
    // no longer pay and a last-seen date months in the past.
    const priceHistory = segmentPriceBands(sorted);
    if (priceHistory.length === 0) continue;
    if (priceHistory.length * MIN_CHARGES_PER_BAND > sorted.length) continue;

    const currentPrice = priceHistory[priceHistory.length - 1];
    if (currentPrice === undefined || currentPrice.amount <= 0) continue;

    const gaps: number[] = [];
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous === undefined || current === undefined) continue;
      gaps.push(daysBetween(previous.date, current.date));
    }

    const cadence = classify(gaps);
    if (cadence === null) continue;

    const amount = currentPrice.amount;
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first === undefined || last === undefined) continue;

    const change = priceChange(priceHistory);

    found.push({
      merchant: representativeName(sorted),
      normalizedName,
      cadence,
      amount,
      chargeCount: sorted.length,
      firstSeen: first.date,
      lastSeen: last.date,
      annualCost: Math.round((cadence === 'monthly' ? amount * 12 : amount) * 100) / 100,
      priceHistory,
      previousAmount: change?.previousAmount ?? null,
      priceChangedOn: change?.changedOn ?? null,
      charges: sorted,
    });
  }

  return found.sort((a, b) => b.annualCost - a.annualCost);
}
