import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { AddressObject } from 'mailparser';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { basename, join } from 'node:path';

/* ------------------------------------------------------------------ types */

export interface EmailMessage {
  /** Message-ID where available, otherwise a stable per-source id. */
  readonly id: string;
  readonly subject: string;
  /** display name and address as one string */
  readonly from: string;
  /** ISO yyyy-mm-dd */
  readonly date: string;
  /** plain text, scrubbed of card numbers and truncated */
  readonly body: string;
}

export interface MailboxWarning {
  readonly source: string;
  readonly message: string;
}

/* -------------------------------------------------------------- scrubbing */

/** Receipt bodies are sent to a model, so strip the one thing that must not travel. */
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/g;

/** Enough for any receipt; keeps a stray marketing email from costing a fortune. */
const MAX_BODY_CHARS = 4_000;

export function scrubBody(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(CARD_NUMBER, '[CARD NUMBER REMOVED]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

/* -------------------------------------------------------------- filtering */

/**
 * Cheap, deterministic pre-filter. Its only job is to keep the model from being
 * shown ten thousand emails: it should over-include rather than miss a receipt,
 * because the model makes the real call afterwards.
 */
const RECEIPT_SUBJECT =
  /receipt|invoice|payment|subscription|subscribed|renew|billing|billed|order confirm|your order|has been charged|thank you for your (payment|order|purchase)|free trial|trial (is )?(ending|started|begins)|price (change|increase)/i;

const RECEIPT_SENDER =
  /no-?reply|do-?not-?reply|billing|receipts?@|invoice|payments?@|subscriptions?@|store@|orders?@/i;

export function looksLikeReceipt(subject: string, from: string): boolean {
  return RECEIPT_SUBJECT.test(subject) || RECEIPT_SENDER.test(from);
}

/* ------------------------------------------------------------ eml  reading */

function formatAddress(address: AddressObject | AddressObject[] | undefined): string {
  if (address === undefined) return '';
  const list = Array.isArray(address) ? address : [address];
  return list.map((entry) => entry.text).join(', ').trim();
}

async function toMessage(source: Buffer | string, fallbackId: string): Promise<EmailMessage> {
  const parsed = await simpleParser(source);
  // mailparser derives `text` from the HTML part when a message has no plain
  // text alternative, so HTML-only receipts arrive already converted.
  const text = parsed.text ?? '';

  return {
    id: parsed.messageId ?? fallbackId,
    subject: parsed.subject ?? '(no subject)',
    from: formatAddress(parsed.from),
    date: (parsed.date ?? new Date()).toISOString().slice(0, 10),
    body: scrubBody(text),
  };
}

/**
 * Read `.eml` files from a directory. Useful without any credentials at all:
 * most mail clients can drag-and-drop or export messages in this format.
 */
export async function readFromDirectory(dir: string): Promise<{
  readonly messages: readonly EmailMessage[];
  readonly warnings: readonly MailboxWarning[];
}> {
  const paths = globSync(join(dir, '**/*.eml')).sort();
  const messages: EmailMessage[] = [];
  const warnings: MailboxWarning[] = [];

  for (const path of paths) {
    try {
      messages.push(await toMessage(readFileSync(path), basename(path)));
    } catch (error) {
      warnings.push({
        source: basename(path),
        message: `could not parse: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (paths.length === 0) warnings.push({ source: dir, message: 'no .eml files found' });
  return { messages, warnings };
}

/* ----------------------------------------------------------- imap reading */

export interface ImapOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
  readonly mailbox: string;
  /** only consider mail on or after this date */
  readonly since: Date;
  /** hard cap on bodies downloaded */
  readonly limit: number;
}

/** Build IMAP settings from the environment, so no secret is ever passed on argv. */
export function imapOptionsFromEnv(overrides: {
  readonly mailbox: string;
  readonly since: Date;
  readonly limit: number;
}): ImapOptions {
  const host = process.env['IMAP_HOST'];
  const user = process.env['IMAP_USER'];
  const password = process.env['IMAP_PASSWORD'];

  const missing = [
    host === undefined || host === '' ? 'IMAP_HOST' : null,
    user === undefined || user === '' ? 'IMAP_USER' : null,
    password === undefined || password === '' ? 'IMAP_PASSWORD' : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} not set in .env. For Gmail, use an app password with ` +
        'IMAP_HOST=imap.gmail.com; or read exported messages instead with --dir <folder>.',
    );
  }

  const port = Number.parseInt(process.env['IMAP_PORT'] ?? '993', 10);
  return {
    host: host as string,
    port: Number.isInteger(port) ? port : 993,
    secure: process.env['IMAP_INSECURE'] !== 'true',
    user: user as string,
    password: password as string,
    mailbox: overrides.mailbox,
    since: overrides.since,
    limit: overrides.limit,
  };
}

/**
 * Fetch candidate receipts over IMAP in two passes: envelopes first, which are
 * small, then bodies only for the messages that survive the pre-filter. On a
 * year of ordinary mail that is the difference between downloading everything
 * and downloading a couple of hundred messages.
 */
export async function fetchFromImap(options: ImapOptions): Promise<{
  readonly messages: readonly EmailMessage[];
  readonly warnings: readonly MailboxWarning[];
  readonly scanned: number;
}> {
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.user, pass: options.password },
    logger: false,
  });

  const messages: EmailMessage[] = [];
  const warnings: MailboxWarning[] = [];
  let scanned = 0;

  await client.connect();
  const lock = await client.getMailboxLock(options.mailbox);
  try {
    const candidates: number[] = [];

    for await (const envelope of client.fetch(
      { since: options.since },
      { envelope: true, uid: true },
    )) {
      scanned += 1;
      const subject = envelope.envelope?.subject ?? '';
      const sender = (envelope.envelope?.from ?? [])
        .map((entry) => `${entry.name ?? ''} <${entry.address ?? ''}>`)
        .join(', ');
      if (looksLikeReceipt(subject, sender)) candidates.push(envelope.uid);
    }

    const wanted = candidates.slice(-options.limit); // newest first when capped
    if (wanted.length > 0) {
      for await (const item of client.fetch(wanted, { source: true, uid: true }, { uid: true })) {
        if (item.source === undefined) continue;
        try {
          messages.push(await toMessage(item.source, `uid-${item.uid}`));
        } catch (error) {
          warnings.push({
            source: `uid-${item.uid}`,
            message: `could not parse: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }

    if (candidates.length > wanted.length) {
      warnings.push({
        source: options.mailbox,
        message: `${candidates.length} candidates found, newest ${wanted.length} used (raise --limit for more)`,
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return { messages, warnings, scanned };
}
