import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';

import type { ModelSender } from '../model/client.js';
import { normalizeMerchant } from './parse-statements.js';
import type { EmailMessage } from './mailbox.js';

/* ------------------------------------------------------------------ types */

/** Email states a cadence outright, so it is not limited to what phase 1 can infer. */
export type ReceiptCadence = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export interface ReceiptSubscription {
  readonly vendor: string;
  readonly normalizedName: string;
  readonly planTier: string | null;
  readonly amount: number;
  readonly currency: string | null;
  readonly cadence: ReceiptCadence;
  /** ISO yyyy-mm-dd, when the receipt states one */
  readonly nextRenewal: string | null;
  readonly isTrial: boolean;
  readonly trialEndsOn: string | null;
  readonly sourceMessageId: string;
  readonly sourceSubject: string;
  /** date of the email this came from */
  readonly seenOn: string;
}

export interface ExtractionWarning {
  readonly source: string;
  readonly message: string;
}

const PER_YEAR: Readonly<Record<ReceiptCadence, number>> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

export function annualCostOf(amount: number, cadence: ReceiptCadence): number {
  return Math.round(amount * PER_YEAR[cadence] * 100) / 100;
}

/* --------------------------------------------------------------- the tool */

const CADENCES: readonly ReceiptCadence[] = ['weekly', 'monthly', 'quarterly', 'annual'];

const RECEIPT_TOOL: Tool = {
  name: 'report_receipt',
  description:
    'Report every recurring subscription described by one email. A single email may ' +
    'cover several subscriptions, or none at all.',
  input_schema: {
    type: 'object',
    properties: {
      isReceipt: {
        type: 'boolean',
        description: 'True if this email is a billing receipt, invoice, renewal or trial notice.',
      },
      subscriptions: {
        type: 'array',
        description: 'One entry per recurring subscription. Empty when there are none.',
        items: {
          type: 'object',
          properties: {
            vendor: { type: 'string', description: 'The service being paid for, not the payment processor.' },
            planTier: { type: ['string', 'null'], description: 'Plan or tier name exactly as written.' },
            amount: { type: 'number', description: 'Recurring charge for this one item.' },
            currency: { type: ['string', 'null'], description: 'ISO 4217 code, e.g. GBP, USD, EUR.' },
            cadence: { type: 'string', enum: [...CADENCES] },
            nextRenewal: { type: ['string', 'null'], description: 'ISO date yyyy-mm-dd if stated.' },
            isTrial: { type: 'boolean', description: 'True if currently in a free or discounted trial.' },
            trialEndsOn: { type: ['string', 'null'], description: 'ISO date yyyy-mm-dd if stated.' },
          },
          required: ['vendor', 'amount', 'cadence', 'isTrial'],
        },
      },
    },
    required: ['isReceipt', 'subscriptions'],
  },
};

const SYSTEM_PROMPT = `You read billing emails and report the recurring subscriptions in them.

Two things matter most:

1. ONE EMAIL CAN CONTAIN SEVERAL SUBSCRIPTIONS. App store and payment-processor
   receipts bundle everything billed that day into one message. List every recurring
   item separately, with its own price. This is the main reason you are being asked:
   a bank statement shows these as a single meaningless line.

2. ONLY RECURRING CHARGES COUNT. A one-off app purchase, a single film rental, a
   physical order, a shipping notice or a refund is not a subscription. Leave those
   out even when they appear on the same receipt as real subscriptions.

Name the service being paid for, not the processor: an Apple receipt for HBO Max is
"HBO Max", not "Apple". Copy plan names and amounts exactly as written. Use the
per-item price, never the order total. If the email is marketing, a security alert,
a delivery update or anything else that is not billing, set isReceipt to false and
return an empty list.`;

/** Two worked examples: an itemised bundle, and an email that is not a receipt. */
function fewShot(): MessageParam[] {
  return [
    {
      role: 'user',
      content: renderEmail({
        id: 'example-apple',
        subject: 'Your receipt from Apple',
        from: 'Apple <no_reply@email.apple.com>',
        date: '2026-03-02',
        body:
          'RECEIPT\nDATE 02/03/2026 ORDER ML0X9\n\n' +
          'iCloud+ 200GB (Monthly) Renews 02/04/2026  £2.99\n' +
          'HBO Max Monthly Subscription Renews 02/04/2026  £9.99\n' +
          'Bear Pro (Yearly) Free trial ends 01/10/2026, then £29.99/year  £0.00\n' +
          'Minecraft  £6.99\n\n' +
          'TOTAL £19.97',
      }),
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_example_apple',
          name: 'report_receipt',
          input: {
            isReceipt: true,
            subscriptions: [
              {
                vendor: 'iCloud+',
                planTier: '200GB',
                amount: 2.99,
                currency: 'GBP',
                cadence: 'monthly',
                nextRenewal: '2026-04-02',
                isTrial: false,
                trialEndsOn: null,
              },
              {
                vendor: 'HBO Max',
                planTier: 'Monthly',
                amount: 9.99,
                currency: 'GBP',
                cadence: 'monthly',
                nextRenewal: '2026-04-02',
                isTrial: false,
                trialEndsOn: null,
              },
              {
                vendor: 'Bear',
                planTier: 'Pro Yearly',
                amount: 29.99,
                currency: 'GBP',
                cadence: 'annual',
                nextRenewal: null,
                isTrial: true,
                trialEndsOn: '2026-10-01',
              },
            ],
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_example_apple', content: 'Recorded.' },
        {
          type: 'text',
          text: renderEmail({
            id: 'example-newsletter',
            subject: 'Your weekly digest is here',
            from: 'Medium Daily <noreply@medium.com>',
            date: '2026-03-04',
            body: 'Here are this week\'s top stories picked for you. Read more in the app.',
          }),
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_example_newsletter',
          name: 'report_receipt',
          input: { isReceipt: false, subscriptions: [] },
        },
      ],
    },
  ];
}

export function renderEmail(message: EmailMessage): string {
  return [
    `FROM: ${message.from}`,
    `DATE: ${message.date}`,
    `SUBJECT: ${message.subject}`,
    '',
    message.body,
  ].join('\n');
}

/* ------------------------------------------------------------- validation */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asIsoDate(value: unknown): string | null {
  const text = asNonEmptyString(value);
  if (text === null || !ISO_DATE.test(text)) return null;
  return Number.isFinite(Date.parse(`${text}T00:00:00Z`)) ? text : null;
}

function asCadence(value: unknown): ReceiptCadence | null {
  const text = asNonEmptyString(value)?.toLowerCase();
  if (text === undefined) return null;
  if (text === 'yearly' || text === 'annually' || text === 'year') return 'annual';
  if (text === 'month') return 'monthly';
  if (text === 'week') return 'weekly';
  if (text === 'quarter') return 'quarterly';
  return CADENCES.find((cadence) => cadence === text) ?? null;
}

export interface ExtractionResult {
  readonly isReceipt: boolean;
  readonly subscriptions: readonly ReceiptSubscription[];
}

/** Turn one tool_use payload into typed rows, dropping anything unusable. */
export function parseReceipt(rawInput: unknown, message: EmailMessage): ExtractionResult {
  const input = asRecord(rawInput);
  if (input === null) return { isReceipt: false, subscriptions: [] };

  const isReceipt = input['isReceipt'] === true;
  const raw = Array.isArray(input['subscriptions']) ? input['subscriptions'] : [];
  const subscriptions: ReceiptSubscription[] = [];

  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) continue;

    const vendor = asNonEmptyString(record['vendor']);
    const amount = typeof record['amount'] === 'number' ? record['amount'] : null;
    const cadence = asCadence(record['cadence']);
    if (vendor === null || amount === null || cadence === null) continue;
    if (!Number.isFinite(amount) || amount < 0) continue;

    subscriptions.push({
      vendor,
      normalizedName: normalizeMerchant(vendor),
      planTier: asNonEmptyString(record['planTier']),
      amount: Math.round(amount * 100) / 100,
      currency: asNonEmptyString(record['currency'])?.toUpperCase() ?? null,
      cadence,
      nextRenewal: asIsoDate(record['nextRenewal']),
      isTrial: record['isTrial'] === true,
      trialEndsOn: asIsoDate(record['trialEndsOn']),
      sourceMessageId: message.id,
      sourceSubject: message.subject,
      seenOn: message.date,
    });
  }

  return { isReceipt, subscriptions };
}

/* ------------------------------------------------------------ extracting */

export async function extractFromEmail(
  message: EmailMessage,
  model: ModelSender,
): Promise<ExtractionResult> {
  const response = await model.send({
    system: SYSTEM_PROMPT,
    messages: [
      ...fewShot(),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_example_newsletter', content: 'Recorded.' },
          { type: 'text', text: renderEmail(message) },
        ],
      },
    ],
    tools: [RECEIPT_TOOL],
    toolChoice: { type: 'tool', name: 'report_receipt' },
    maxTokens: 1_536,
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (toolUse === undefined) return { isReceipt: false, subscriptions: [] };
  return parseReceipt(toolUse.input, message);
}

/** Small fixed pool: enough to keep a few hundred emails quick, gentle on rate limits. */
const CONCURRENCY = 4;

export async function extractSubscriptions(options: {
  readonly messages: readonly EmailMessage[];
  readonly model: ModelSender;
  readonly onProgress?: (done: number, total: number, found: number) => void;
}): Promise<{
  readonly subscriptions: readonly ReceiptSubscription[];
  readonly receipts: number;
  readonly warnings: readonly ExtractionWarning[];
}> {
  const found: ReceiptSubscription[] = [];
  const warnings: ExtractionWarning[] = [];
  let receipts = 0;
  let done = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const message = options.messages[index];
      if (message === undefined) return;

      try {
        const result = await extractFromEmail(message, options.model);
        if (result.isReceipt) receipts += 1;
        found.push(...result.subscriptions);
      } catch (error) {
        warnings.push({
          source: message.subject,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      done += 1;
      options.onProgress?.(done, options.messages.length, found.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, options.messages.length) }, () => worker()),
  );

  return { subscriptions: found, receipts, warnings };
}

/* ---------------------------------------------------------------- dedupe */

/**
 * A monthly subscription produces a receipt every month. Collapse them to one
 * row per service and plan, keeping the most recent — that is the one with the
 * current price and the useful renewal date.
 */
export function dedupeSubscriptions(
  items: readonly ReceiptSubscription[],
): readonly ReceiptSubscription[] {
  const best = new Map<string, ReceiptSubscription>();

  for (const item of items) {
    const key = `${item.normalizedName}|${item.cadence}|${(item.planTier ?? '').toLowerCase()}`;
    const existing = best.get(key);
    if (existing === undefined || item.seenOn > existing.seenOn) {
      best.set(key, item);
      continue;
    }
    // Same date: prefer the row that actually states a renewal date.
    if (item.seenOn === existing.seenOn && existing.nextRenewal === null && item.nextRenewal !== null) {
      best.set(key, item);
    }
  }

  return [...best.values()].sort(
    (a, b) => annualCostOf(b.amount, b.cadence) - annualCostOf(a.amount, a.cadence),
  );
}
