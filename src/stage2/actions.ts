import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { Locator, Page } from 'playwright';

/* ------------------------------------------------------------------ types */

export type ScrollDirection = 'up' | 'down';

/** The complete action space. Nothing else can reach the page. */
export type AgentAction =
  | { readonly kind: 'click'; readonly elementId: number; readonly reason: string }
  | {
      readonly kind: 'fill';
      readonly elementId: number;
      /** an env key name such as NOTION_PASSWORD — never a literal value */
      readonly valueRef: string;
      readonly reason: string;
    }
  | { readonly kind: 'scroll'; readonly direction: ScrollDirection; readonly reason: string }
  | { readonly kind: 'navigate'; readonly url: string; readonly reason: string }
  | { readonly kind: 'extract'; readonly fields: Readonly<Record<string, string>>; readonly reason: string }
  | { readonly kind: 'giveUp'; readonly reason: string };

export interface ActionResult {
  readonly ok: boolean;
  /** fed back to the model verbatim; must never contain a secret value */
  readonly message: string;
  /** true when this action ends the task */
  readonly terminal: boolean;
}

export interface ExecutionContext {
  readonly page: Page;
  /** maps a model-supplied element id back to a real locator */
  readonly resolve: (elementId: number) => Locator | null;
  /** task origin; navigation may not leave it */
  readonly origin: string;
  readonly dryRun: boolean;
  /** called with any secret the executor resolves, so traces can redact it */
  readonly registerSecret: (value: string) => void;
}

/* ------------------------------------------------------- tool definitions */

const REASON: Readonly<Record<string, unknown>> = {
  type: 'string',
  description: 'Why this action moves you towards the goal. One short sentence.',
};

const ELEMENT_ID: Readonly<Record<string, unknown>> = {
  type: 'integer',
  description: 'The id of a target element, taken from the numbered element list.',
};

export const TOOLS: readonly Tool[] = [
  {
    name: 'click',
    description: 'Click an element from the numbered element list.',
    input_schema: {
      type: 'object',
      properties: { elementId: ELEMENT_ID, reason: REASON },
      required: ['elementId', 'reason'],
    },
  },
  {
    name: 'fill',
    description:
      'Type a configured credential into an input. You never supply the value itself: ' +
      'give the NAME of the credential (for example NOTION_PASSWORD) and it is resolved ' +
      'privately at fill time. Values you type literally will be rejected.',
    input_schema: {
      type: 'object',
      properties: {
        elementId: ELEMENT_ID,
        valueRef: {
          type: 'string',
          description: 'Credential key name: UPPER_SNAKE_CASE, e.g. NOTION_EMAIL, NOTION_PASSWORD.',
          pattern: '^[A-Z][A-Z0-9_]*$',
        },
        reason: REASON,
      },
      required: ['elementId', 'valueRef', 'reason'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page to reveal more content.',
    input_schema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down'] }, reason: REASON },
      required: ['direction', 'reason'],
    },
  },
  {
    name: 'navigate',
    description: 'Go to a URL on the same site. Off-site navigation is blocked.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, reason: REASON },
      required: ['url', 'reason'],
    },
  },
  {
    name: 'extract',
    description:
      'Report the billing details you found and finish the task. Use this as soon as the ' +
      'page shows what the goal asked for.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description:
            'Field name to value, e.g. {"plan":"Plus","amount":"$8.00","cadence":"monthly",' +
            '"nextRenewal":"2025-04-01"}. Use the exact text shown on the page.',
          additionalProperties: { type: 'string' },
        },
        reason: REASON,
      },
      required: ['fields', 'reason'],
    },
  },
  {
    name: 'giveUp',
    description: 'Stop the task because the goal cannot be reached.',
    input_schema: { type: 'object', properties: { reason: REASON }, required: ['reason'] },
  },
];

/* ------------------------------------------------------------- validation */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asElementId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A credential reference must look like an env key, never like a value. */
export const VALUE_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export type ParsedAction =
  | { readonly ok: true; readonly action: AgentAction }
  | { readonly ok: false; readonly error: string };

/** Turn an untrusted tool_use payload into a typed action, or an explainable error. */
export function parseToolUse(name: string, rawInput: unknown): ParsedAction {
  const input = asRecord(rawInput);
  if (input === null) return { ok: false, error: 'tool input was not an object' };

  const reason = asString(input['reason']);
  if (reason === null && name !== 'extract') {
    return { ok: false, error: 'every action requires a non-empty "reason"' };
  }

  switch (name) {
    case 'click': {
      const elementId = asElementId(input['elementId']);
      if (elementId === null) return { ok: false, error: 'click needs an integer "elementId"' };
      return { ok: true, action: { kind: 'click', elementId, reason: reason ?? '' } };
    }
    case 'fill': {
      const elementId = asElementId(input['elementId']);
      if (elementId === null) return { ok: false, error: 'fill needs an integer "elementId"' };
      const valueRef = asString(input['valueRef']);
      if (valueRef === null) return { ok: false, error: 'fill needs a "valueRef"' };
      if (!VALUE_REF_PATTERN.test(valueRef)) {
        // The model tried to pass a literal. Never echo it back.
        return {
          ok: false,
          error:
            'REJECTED: "valueRef" must be a credential key name in UPPER_SNAKE_CASE, not a value. ' +
            'The literal you sent was discarded.',
        };
      }
      return { ok: true, action: { kind: 'fill', elementId, valueRef, reason: reason ?? '' } };
    }
    case 'scroll': {
      const direction = asString(input['direction']);
      if (direction !== 'up' && direction !== 'down') {
        return { ok: false, error: 'scroll needs "direction" of "up" or "down"' };
      }
      return { ok: true, action: { kind: 'scroll', direction, reason: reason ?? '' } };
    }
    case 'navigate': {
      const url = asString(input['url']);
      if (url === null) return { ok: false, error: 'navigate needs a "url"' };
      return { ok: true, action: { kind: 'navigate', url, reason: reason ?? '' } };
    }
    case 'extract': {
      const rawFields = asRecord(input['fields']);
      if (rawFields === null) return { ok: false, error: 'extract needs a "fields" object' };
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawFields)) {
        if (typeof value === 'string') fields[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') fields[key] = String(value);
      }
      if (Object.keys(fields).length === 0) return { ok: false, error: '"fields" was empty' };
      return { ok: true, action: { kind: 'extract', fields, reason: reason ?? 'extracted' } };
    }
    case 'giveUp':
      return { ok: true, action: { kind: 'giveUp', reason: reason ?? '' } };
    default:
      return { ok: false, error: `unknown tool "${name}"` };
  }
}

/* --------------------------------------------------------------- executor */

const ACTION_TIMEOUT_MS = 10_000;

function describe(action: AgentAction): string {
  switch (action.kind) {
    case 'click':
      return `click element ${action.elementId}`;
    case 'fill':
      return `fill element ${action.elementId} from ${action.valueRef}`;
    case 'scroll':
      return `scroll ${action.direction}`;
    case 'navigate':
      return `navigate to ${action.url}`;
    case 'extract':
      return 'extract and finish';
    case 'giveUp':
      return 'give up';
  }
}

/** Best-effort settle after an action; a timeout here is normal, not an error. */
async function settle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 });
  } catch {
    /* page was already stable, or is still busy — either is fine */
  }
}

export async function executeAction(action: AgentAction, ctx: ExecutionContext): Promise<ActionResult> {
  if (action.kind === 'extract') {
    return { ok: true, message: 'extraction recorded; task complete', terminal: true };
  }
  if (action.kind === 'giveUp') {
    return { ok: true, message: `gave up: ${action.reason}`, terminal: true };
  }

  if (ctx.dryRun) {
    return { ok: true, message: `DRY RUN: would ${describe(action)}`, terminal: false };
  }

  try {
    switch (action.kind) {
      case 'click': {
        const locator = ctx.resolve(action.elementId);
        if (locator === null) return { ok: false, message: `no element with id ${action.elementId}`, terminal: false };
        await locator.click({ timeout: ACTION_TIMEOUT_MS });
        await settle(ctx.page);
        return { ok: true, message: `clicked element ${action.elementId}`, terminal: false };
      }

      case 'fill': {
        const locator = ctx.resolve(action.elementId);
        if (locator === null) return { ok: false, message: `no element with id ${action.elementId}`, terminal: false };

        const secret = process.env[action.valueRef];
        if (secret === undefined || secret === '') {
          return {
            ok: false,
            message: `UNKNOWN_VALUE_REF: ${action.valueRef} is not configured in .env`,
            terminal: false,
          };
        }
        ctx.registerSecret(secret);
        await locator.fill(secret, { timeout: ACTION_TIMEOUT_MS });
        // Report the key name only. The value never enters a message, a trace or a prompt.
        return { ok: true, message: `filled element ${action.elementId} from ${action.valueRef}`, terminal: false };
      }

      case 'scroll': {
        const delta = action.direction === 'down' ? 800 : -800;
        await ctx.page.mouse.wheel(0, delta);
        await ctx.page.waitForTimeout(250);
        return { ok: true, message: `scrolled ${action.direction}`, terminal: false };
      }

      case 'navigate': {
        // Guards already checked this; re-check so the executor is safe on its own.
        let target: URL;
        try {
          target = new URL(action.url, ctx.page.url());
        } catch {
          return { ok: false, message: `not a valid URL: ${action.url}`, terminal: false };
        }
        if (target.origin !== ctx.origin) {
          return { ok: false, message: `BLOCKED: off-origin navigation to ${target.origin}`, terminal: false };
        }
        await ctx.page.goto(target.href, { timeout: 30_000, waitUntil: 'domcontentloaded' });
        return { ok: true, message: `navigated to ${target.href}`, terminal: false };
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
    return { ok: false, message: `failed to ${describe(action)}: ${detail}`, terminal: false };
  }
}
