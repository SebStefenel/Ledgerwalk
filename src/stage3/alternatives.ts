import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';

import type { ModelSender } from '../model/client.js';

/* ------------------------------------------------------------------ types */

export type MigrationEffort = 'low' | 'medium' | 'high';
export type Confidence = 'low' | 'medium' | 'high';

/** Why a category has no genuine open-source substitute. */
export type NoAlternativeCategory =
  | 'content_licensing'
  | 'physical_logistics'
  | 'regulated_service'
  | 'network_effect'
  | 'other';

export interface RepoHealth {
  readonly stars: number;
  /** ISO date of the last push */
  readonly lastCommit: string;
  /** untouched for 18 months or more */
  readonly stale: boolean;
}

export interface Alternative {
  readonly alternative: string;
  readonly repoUrl: string | null;
  readonly license: string | null;
  readonly selfHostRequired: boolean;
  readonly migrationEffort: MigrationEffort;
  readonly annualSavings: number;
  readonly featuresLost: readonly string[];
  readonly confidence: Confidence;
  readonly reason: string;
  /** filled in from the GitHub API when a repo URL is present */
  readonly repoHealth: RepoHealth | null;
}

/** The model either names a substitute, or explains why none exists. */
export type Suggestion =
  | { readonly kind: 'alternative'; readonly value: Alternative }
  | {
      readonly kind: 'none';
      readonly reason: string;
      readonly category: NoAlternativeCategory;
      readonly confidence: Confidence;
    };

export interface SubscriptionInput {
  readonly service: string;
  /** plan tier, when phase 2 managed to read one */
  readonly planTier: string | null;
  readonly annualCost: number;
}

/* --------------------------------------------------------------- the tool */

const MIGRATION_EFFORTS: readonly MigrationEffort[] = ['low', 'medium', 'high'];
const CONFIDENCES: readonly Confidence[] = ['low', 'medium', 'high'];
const CATEGORIES: readonly NoAlternativeCategory[] = [
  'content_licensing',
  'physical_logistics',
  'regulated_service',
  'network_effect',
  'other',
];

const REPORT_TOOL: Tool = {
  name: 'report_alternative',
  description:
    'Report either one open-source or free alternative to a paid subscription, or that ' +
    'no genuine alternative exists for this category.',
  input_schema: {
    type: 'object',
    properties: {
      alternative: {
        type: ['string', 'null'],
        description:
          'Name of the open-source or free alternative, or null when no genuine substitute exists.',
      },
      reason: {
        type: 'string',
        description:
          'One or two sentences: why this substitute fits, or why the category has no real substitute.',
      },
      noAlternativeCategory: {
        type: ['string', 'null'],
        enum: [...CATEGORIES, null],
        description: 'Required when alternative is null; otherwise null.',
      },
      repoUrl: { type: ['string', 'null'], description: 'Source repository URL, if there is one.' },
      license: { type: ['string', 'null'], description: 'SPDX identifier, e.g. AGPL-3.0, MIT.' },
      selfHostRequired: {
        type: ['boolean', 'null'],
        description: 'True when using it means running a server yourself.',
      },
      migrationEffort: { type: ['string', 'null'], enum: [...MIGRATION_EFFORTS, null] },
      annualSavings: {
        type: ['number', 'null'],
        description: 'Realistic yearly saving, never more than the current annual cost.',
      },
      featuresLost: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete things you give up. Empty when nothing meaningful is lost.',
      },
      confidence: { type: 'string', enum: [...CONFIDENCES] },
    },
    required: ['alternative', 'reason', 'featuresLost', 'confidence'],
  },
};

const SYSTEM_PROMPT = `You advise on replacing paid subscriptions with open-source or free alternatives.

You are useful precisely because you are honest about when there is no substitute. Some
categories cannot be replaced by open source at all:

- content_licensing: the product is a licensed catalogue (streaming music, film, ebooks).
  Software cannot license the catalogue.
- physical_logistics: the product is physical delivery, warehousing or hardware.
- regulated_service: banking, insurance, tax filing, payroll, identity — regulation and
  liability are the product.
- network_effect: the value is that other specific people are already there.

For those, set alternative to null, give the category, and explain in one sentence. A
plausible-sounding project that does not actually replace the service is worse than an
honest null. Do not suggest a self-hosted media server as a replacement for a streaming
catalogue, and do not suggest a shopping app as a replacement for delivery.

When a real substitute does exist, name one — the best fit, not a list. Be concrete about
what is lost, and keep annualSavings realistic: self-hosting has running costs, so it is
rarely the full subscription price.`;

/** Two worked examples, one substitutable and one not, so the refusal is modelled. */
function fewShot(): MessageParam[] {
  return [
    { role: 'user', content: renderRequest({ service: 'Notion', planTier: 'Plus', annualCost: 96 }) },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_example_notion',
          name: 'report_alternative',
          input: {
            alternative: 'AppFlowy',
            reason:
              'AppFlowy covers the same documents-plus-databases model as Notion and imports ' +
              'Notion exports, so the day-to-day workflow survives the move.',
            noAlternativeCategory: null,
            repoUrl: 'https://github.com/AppFlowy-IO/AppFlowy',
            license: 'AGPL-3.0',
            selfHostRequired: false,
            migrationEffort: 'medium',
            annualSavings: 96,
            featuresLost: [
              'real-time multiplayer editing is less mature',
              'no published API integrations directory',
              'weaker mobile apps',
            ],
            confidence: 'high',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_example_notion', content: 'Recorded.' },
        {
          type: 'text',
          text: renderRequest({ service: 'Amazon Prime', planTier: 'Annual', annualCost: 139 }),
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_example_prime',
          name: 'report_alternative',
          input: {
            alternative: null,
            reason:
              'Prime is next-day physical delivery from Amazon warehouses, bundled with a ' +
              'licensed video catalogue. Neither can be replaced by software you run yourself.',
            noAlternativeCategory: 'physical_logistics',
            repoUrl: null,
            license: null,
            selfHostRequired: null,
            migrationEffort: null,
            annualSavings: null,
            featuresLost: [],
            confidence: 'high',
          },
        },
      ],
    },
  ];
}

export function renderRequest(input: SubscriptionInput): string {
  return [
    `SERVICE: ${input.service}`,
    `PLAN: ${input.planTier ?? '(unknown)'}`,
    `ANNUAL COST: ${input.annualCost.toFixed(2)}`,
    '',
    'Suggest one open-source or free alternative, or report that none genuinely exists.',
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

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  const text = asNonEmptyString(value);
  if (text === null) return null;
  return allowed.find((option) => option === text.toLowerCase()) ?? null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

export type ParsedSuggestion =
  | { readonly ok: true; readonly suggestion: Suggestion }
  | { readonly ok: false; readonly error: string };

/**
 * Turn the model's tool input into a typed suggestion.
 *
 * `annualSavings` is clamped to the amount actually being paid: a suggestion
 * that claims to save more than the subscription costs is arithmetic noise, and
 * it would inflate the total at the top of the report.
 */
export function parseSuggestion(rawInput: unknown, annualCost: number): ParsedSuggestion {
  const input = asRecord(rawInput);
  if (input === null) return { ok: false, error: 'tool input was not an object' };

  const reason = asNonEmptyString(input['reason']);
  if (reason === null) return { ok: false, error: 'a "reason" is required' };

  const confidence = asEnum(input['confidence'], CONFIDENCES) ?? 'low';
  const name = asNonEmptyString(input['alternative']);

  if (name === null) {
    return {
      ok: true,
      suggestion: {
        kind: 'none',
        reason,
        category: asEnum(input['noAlternativeCategory'], CATEGORIES) ?? 'other',
        confidence,
      },
    };
  }

  const rawSavings = typeof input['annualSavings'] === 'number' ? input['annualSavings'] : null;
  const savings = rawSavings === null ? annualCost : Math.max(0, Math.min(rawSavings, annualCost));

  return {
    ok: true,
    suggestion: {
      kind: 'alternative',
      value: {
        alternative: name,
        reason,
        repoUrl: asNonEmptyString(input['repoUrl']),
        license: asNonEmptyString(input['license']),
        selfHostRequired: input['selfHostRequired'] === true,
        migrationEffort: asEnum(input['migrationEffort'], MIGRATION_EFFORTS) ?? 'medium',
        annualSavings: Math.round(savings * 100) / 100,
        featuresLost: asStringArray(input['featuresLost']),
        confidence,
        repoHealth: null,
      },
    },
  };
}

/* ------------------------------------------------------- github  checking */

const STALE_AFTER_MONTHS = 18;

export function parseGitHubRepo(url: string): { readonly owner: string; readonly repo: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null;
    const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
    const owner = segments[0];
    const repo = segments[1];
    if (owner === undefined || repo === undefined) return null;
    return { owner, repo: repo.replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

export function isStale(lastCommit: string, now: Date = new Date()): boolean {
  const pushed = Date.parse(lastCommit);
  if (!Number.isFinite(pushed)) return false;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - STALE_AFTER_MONTHS);
  return pushed < cutoff.getTime();
}

type Fetcher = (url: string, init?: { readonly headers?: Record<string, string> }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Look up stars and last push date. This column is allowed to be imperfect: any
 * failure, including rate limiting, returns null and the report simply omits it.
 */
export async function checkRepoHealth(
  repoUrl: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
  now: Date = new Date(),
): Promise<RepoHealth | null> {
  const parsed = parseGitHubRepo(repoUrl);
  if (parsed === null) return null;

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'ledgerwalk',
  };
  const token = process.env['GITHUB_TOKEN'];
  if (token !== undefined && token !== '') headers['authorization'] = `Bearer ${token}`;

  try {
    const response = await fetcher(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers,
    });
    if (!response.ok) return null; // 404, 403 rate limit, anything else: skip silently
    const body = asRecord(await response.json());
    if (body === null) return null;

    const stars = typeof body['stargazers_count'] === 'number' ? body['stargazers_count'] : 0;
    const pushedAt = asNonEmptyString(body['pushed_at']);
    if (pushedAt === null) return null;

    return { stars, lastCommit: pushedAt.slice(0, 10), stale: isStale(pushedAt, now) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ the  caller */

/** One model call per subscription, then an optional repo health check. */
export async function suggestAlternative(options: {
  readonly input: SubscriptionInput;
  readonly model: ModelSender;
  readonly verifyRepo?: boolean;
  readonly fetcher?: Fetcher;
}): Promise<ParsedSuggestion> {
  const message = await options.model.send({
    system: SYSTEM_PROMPT,
    messages: [
      ...fewShot(),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_example_prime', content: 'Recorded.' },
          { type: 'text', text: renderRequest(options.input) },
        ],
      },
    ],
    tools: [REPORT_TOOL],
    toolChoice: { type: 'tool', name: 'report_alternative' },
    maxTokens: 1_024,
  });

  const toolUse = message.content.find((block) => block.type === 'tool_use');
  if (toolUse === undefined) return { ok: false, error: 'the model did not call report_alternative' };

  const parsed = parseSuggestion(toolUse.input, options.input.annualCost);
  if (!parsed.ok || parsed.suggestion.kind !== 'alternative') return parsed;
  if (options.verifyRepo === false) return parsed;

  const repoUrl = parsed.suggestion.value.repoUrl;
  if (repoUrl === null) return parsed;

  const health = await checkRepoHealth(
    repoUrl,
    options.fetcher ?? (globalThis.fetch as unknown as Fetcher),
  );
  return {
    ok: true,
    suggestion: { kind: 'alternative', value: { ...parsed.suggestion.value, repoHealth: health } },
  };
}
