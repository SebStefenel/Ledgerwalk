import type { AgentAction } from './actions.js';
import type { ObservedElement } from './observe.js';

/**
 * Hard limits, checked immediately before execution and independently of the
 * prompt. The model is told about them, but nothing here depends on the model
 * having read, understood, or obeyed that.
 *
 * This tool reads billing pages. It must not be able to cancel anything, even
 * if the model decides that would be helpful.
 */

/** Controls that end or downgrade a subscription. Never clickable. */
export const FORBIDDEN_CONTROL = /cancel (subscription|plan|membership)|delete account|close account|downgrade|confirm cancel/i;

/** A page that is part of a cancellation or deletion flow. */
export const CANCELLATION_URL = /cancel|close|delete/i;

export interface GuardContext {
  readonly currentUrl: string;
  /** origin the task started on */
  readonly origin: string;
  /** the element the action targets, when it targets one */
  readonly element: ObservedElement | null;
}

export type GuardVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly rule: string;
      readonly detail: string;
      /**
       * True when the agent has reached a cancellation confirmation. The spec
       * allows walking up to one to observe it; the run screenshots and stops
       * there rather than probing further.
       */
      readonly halt: boolean;
    };

function deny(rule: string, detail: string, halt = false): GuardVerdict {
  return { allowed: false, rule, detail, halt };
}

export function checkAction(action: AgentAction, ctx: GuardContext): GuardVerdict {
  // 1. Destructive controls, by accessible name.
  if (action.kind === 'click' || action.kind === 'fill') {
    const name = ctx.element?.name ?? '';
    if (FORBIDDEN_CONTROL.test(name)) {
      return deny(
        'FORBIDDEN_CONTROL',
        `"${name}" is a cancellation, downgrade or account-deletion control. This tool only reads billing pages.`,
        true,
      );
    }
  }

  // 2. Any form submit while inside a cancellation flow.
  if (action.kind === 'click' && ctx.element !== null && ctx.element.isSubmit) {
    if (CANCELLATION_URL.test(ctx.currentUrl)) {
      return deny(
        'SUBMIT_ON_CANCELLATION_PAGE',
        `submitting a form on ${ctx.currentUrl} could confirm a cancellation. Observed and stopped here.`,
        true,
      );
    }
  }

  // 3. Navigation must stay on the origin the task started on.
  if (action.kind === 'navigate') {
    let target: URL;
    try {
      target = new URL(action.url, ctx.currentUrl);
    } catch {
      return deny('INVALID_URL', `"${action.url}" is not a URL.`);
    }
    if (target.origin !== ctx.origin) {
      return deny('OFF_ORIGIN_NAVIGATION', `${target.origin} is outside the task origin ${ctx.origin}.`);
    }
  }

  return { allowed: true };
}

/** The tool_result string handed back to the model when an action is refused. */
export function blockedMessage(verdict: Extract<GuardVerdict, { allowed: false }>): string {
  return `BLOCKED: ${verdict.rule} — ${verdict.detail}`;
}
