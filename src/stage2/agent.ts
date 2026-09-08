import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Page } from 'playwright';

import { TOOLS, executeAction, parseToolUse } from './actions.js';
import type { AgentAction } from './actions.js';
import { attemptReauth, launchContext, looksLikeLogin } from './auth.js';
import { blockedMessage, checkAction } from './guards.js';
import { observe } from './observe.js';
import type { ModelSender } from '../model/client.js';
import { Redactor, TraceLogger } from '../trace/logger.js';
import type { TaskResult, TaskStatus, TokenUsage } from '../trace/logger.js';

/* --------------------------------------------------------- task  loading */

export interface ServiceTask {
  readonly name: string;
  readonly url: string;
  readonly goal: string;
  readonly authFile: string;
}

function readString(record: Readonly<Record<string, unknown>>, key: string, index: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`tasks entry #${index + 1} is missing a non-empty "${key}"`);
  }
  return value.trim();
}

export function loadServices(path: string): readonly ServiceTask[] {
  const parsed: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a list of services`);

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`tasks entry #${index + 1} is not a mapping`);
    }
    const record = entry as Readonly<Record<string, unknown>>;
    const name = readString(record, 'name', index);
    const authFile = typeof record['authFile'] === 'string' && record['authFile'].trim() !== ''
      ? record['authFile'].trim()
      : `.auth/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    return {
      name,
      url: readString(record, 'url', index),
      goal: readString(record, 'goal', index),
      authFile,
    };
  });
}

/* ------------------------------------------------------------- prompting */

const SYSTEM_PROMPT = `You are auditing one subscription's billing page in a real browser.

Your job is to READ information. You never change, cancel, downgrade or delete anything.

Each turn you are given the goal, a description of the current page, and your last few
actions. Choose exactly one action.

Rules:
- Refer to page elements by the integer id shown in the element list. Never write a CSS
  selector, XPath, or element description as a target — only the id.
- To type a credential, call fill with the NAME of the credential (for example
  NOTION_PASSWORD). You are never given the value and must never invent one; a literal
  value in valueRef is rejected.
- Stay on the site you started on.
- Destructive controls are blocked before they run: cancelling a subscription, downgrading
  a plan, closing or deleting an account, and submitting forms inside a cancellation flow.
  If an action comes back BLOCKED, do not try a variation of it. Find a read-only route to
  the same information.
- Billing details usually live under Settings, then Billing, Plans, or Subscription.
- Call extract the moment the page shows what the goal asked for. Copy the values exactly
  as they appear on screen; do not calculate, convert or guess them. If a field genuinely
  is not shown, leave it out rather than inventing it.
- If you are going in circles or the information is not reachable, call giveUp.`;

interface HistoryEntry {
  readonly step: number;
  readonly action: AgentAction | null;
  readonly outcome: string;
}

function summarise(action: AgentAction | null): string {
  if (action === null) return 'no action (unparseable tool call)';
  switch (action.kind) {
    case 'click':
      return `click(element ${action.elementId})`;
    case 'fill':
      return `fill(element ${action.elementId}, ${action.valueRef})`;
    case 'scroll':
      return `scroll(${action.direction})`;
    case 'navigate':
      return `navigate(${action.url})`;
    case 'extract':
      return `extract(${Object.keys(action.fields).join(', ')})`;
    case 'giveUp':
      return 'giveUp';
  }
}

const HISTORY_WINDOW = 5;

function renderPrompt(options: {
  readonly goal: string;
  readonly observation: string;
  readonly history: readonly HistoryEntry[];
  readonly step: number;
  readonly maxSteps: number;
}): string {
  const recent = options.history.slice(-HISTORY_WINDOW);
  const historyText =
    recent.length === 0
      ? '  (nothing yet — this is the first step)'
      : recent.map((entry) => `  #${entry.step} ${summarise(entry.action)} -> ${entry.outcome}`).join('\n');

  return [
    `GOAL: ${options.goal}`,
    '',
    `STEP ${options.step} of ${options.maxSteps}`,
    '',
    'YOUR LAST ACTIONS:',
    historyText,
    '',
    'CURRENT PAGE:',
    options.observation,
  ].join('\n');
}

/* ------------------------------------------------------------- the  loop */

export const DEFAULT_MAX_STEPS = 25;

export interface RunOptions {
  readonly task: ServiceTask;
  readonly model: ModelSender;
  readonly headed: boolean;
  readonly dryRun: boolean;
  readonly maxSteps?: number;
  readonly traceRoot?: string;
}

export interface RunOutcome {
  readonly result: TaskResult;
  readonly traceDir: string;
}

async function screenshot(page: Page, path: string): Promise<string | null> {
  try {
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch {
    return null;
  }
}

/**
 * observe -> ask the model for one action -> execute -> repeat.
 *
 * The model gets a fresh prompt each step (goal, page, last five actions, step
 * count) rather than a growing transcript. That keeps cost flat across a run and
 * stops early mistakes from anchoring later steps.
 */
export async function runTask(options: RunOptions): Promise<RunOutcome> {
  const { task, model, headed, dryRun } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const startedAt = new Date().toISOString();

  const redactor = Redactor.fromEnvironment();
  const logger = TraceLogger.create({
    service: task.name,
    goal: task.goal,
    url: task.url,
    maxSteps,
    dryRun,
    redactor,
    ...(options.traceRoot === undefined ? {} : { root: options.traceRoot }),
  });

  const history: HistoryEntry[] = [];
  let status: TaskStatus = 'step_limit';
  let reason = `reached the ${maxSteps}-step limit without finding the billing details`;
  let fields: Readonly<Record<string, string>> | null = null;
  let stepsTaken = 0;

  const { context, close } = await launchContext({
    authFile: task.authFile,
    headed,
    tracePath: logger.playwrightTracePath,
  });

  const finish = (): RunOutcome => {
    const result: TaskResult = {
      service: task.name,
      goal: task.goal,
      status,
      fields,
      reason,
      steps: stepsTaken,
      tokens: model.tokens,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    logger.finish(result);
    return { result, traceDir: logger.dir };
  };

  try {
    const page = await context.newPage();
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const origin = new URL(task.url).origin;

    let reauthUsed = false;
    let step = 1;

    while (step <= maxSteps) {
      const observation = await observe(page, task.goal);

      // Session expired mid-run: re-authenticate once, then carry on from here
      // rather than restarting the task. A second failure is fatal.
      if (await looksLikeLogin(page)) {
        if (reauthUsed) {
          status = 'auth_expired';
          reason = 'AUTH_EXPIRED: landed on a login page again after re-authenticating once';
          break;
        }
        reauthUsed = true;
        const began = Date.now();
        const outcome = await attemptReauth({ page, service: task.name, redactor });
        logger.step({
          step,
          timestamp: new Date().toISOString(),
          url: observation.url,
          observationHash: observation.hash,
          action: null,
          parseError: null,
          result: {
            ok: outcome.ok,
            message: outcome.ok ? 're-authenticated with stored credentials' : outcome.reason,
            blockedBy: null,
          },
          latencyMs: Date.now() - began,
          tokens: { input: 0, output: 0 },
          screenshot: null,
        });
        if (!outcome.ok) {
          status = 'auth_expired';
          reason = outcome.reason;
          break;
        }
        continue; // re-observe the page we were on; the step is not spent
      }

      const began = Date.now();
      const message = await model.send({
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: renderPrompt({
              goal: task.goal,
              observation: observation.text,
              history,
              step,
              maxSteps,
            }),
          },
        ],
        tools: TOOLS,
        toolChoice: { type: 'any' },
      });

      const stepTokens: TokenUsage = {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
      };
      const toolUse = message.content.find((block) => block.type === 'tool_use');

      // --- the model did not call a tool -------------------------------------
      if (toolUse === undefined) {
        const outcome = 'no tool call in the response; choose exactly one action';
        history.push({ step, action: null, outcome });
        logger.step({
          step,
          timestamp: new Date().toISOString(),
          url: observation.url,
          observationHash: observation.hash,
          action: null,
          parseError: outcome,
          result: { ok: false, message: outcome, blockedBy: null },
          latencyMs: Date.now() - began,
          tokens: stepTokens,
          screenshot: null,
        });
        stepsTaken = step;
        step += 1;
        continue;
      }

      const parsed = parseToolUse(toolUse.name, toolUse.input);

      // --- the tool call did not validate -----------------------------------
      if (!parsed.ok) {
        history.push({ step, action: null, outcome: parsed.error });
        logger.step({
          step,
          timestamp: new Date().toISOString(),
          url: observation.url,
          observationHash: observation.hash,
          action: null,
          parseError: parsed.error,
          result: { ok: false, message: parsed.error, blockedBy: null },
          latencyMs: Date.now() - began,
          tokens: stepTokens,
          screenshot: null,
        });
        stepsTaken = step;
        step += 1;
        continue;
      }

      const action = parsed.action;
      const targetId =
        action.kind === 'click' || action.kind === 'fill' ? action.elementId : null;
      const element =
        targetId === null ? null : observation.elements.find((item) => item.id === targetId) ?? null;

      // --- guards, before anything touches the page -------------------------
      const verdict = checkAction(action, { currentUrl: observation.url, origin, element });
      if (!verdict.allowed) {
        const outcome = blockedMessage(verdict);
        logger.blocked(step, verdict.rule, action);
        console.warn(`  ${outcome}`);
        history.push({ step, action, outcome });
        const shot = await screenshot(page, logger.screenshotPath(step));
        logger.step({
          step,
          timestamp: new Date().toISOString(),
          url: observation.url,
          observationHash: observation.hash,
          action,
          parseError: null,
          result: { ok: false, message: outcome, blockedBy: verdict.rule },
          latencyMs: Date.now() - began,
          tokens: stepTokens,
          screenshot: shot === null ? null : logger.screenshotName(step),
        });
        stepsTaken = step;

        if (verdict.halt) {
          status = 'stopped_at_cancel';
          reason = outcome;
          break;
        }
        step += 1;
        continue;
      }

      // --- execute -----------------------------------------------------------
      const result = await executeAction(action, {
        page,
        resolve: observation.resolve,
        origin,
        dryRun,
        registerSecret: (value: string) => redactor.add(value),
      });

      history.push({ step, action, outcome: result.message });
      const shot = await screenshot(page, logger.screenshotPath(step));
      logger.step({
        step,
        timestamp: new Date().toISOString(),
        url: observation.url,
        observationHash: observation.hash,
        action,
        parseError: null,
        result: { ok: result.ok, message: result.message, blockedBy: null },
        latencyMs: Date.now() - began,
        tokens: stepTokens,
        screenshot: shot === null ? null : logger.screenshotName(step),
      });
      stepsTaken = step;

      console.log(`  #${step} ${summarise(action)} -> ${result.message}`);

      if (action.kind === 'extract') {
        status = 'extracted';
        fields = action.fields;
        reason = action.reason;
        break;
      }
      if (action.kind === 'giveUp') {
        status = 'gave_up';
        reason = action.reason;
        break;
      }
      if (dryRun) {
        status = 'dry_run';
        reason = 'dry run: proposed one action and stopped without executing it';
        break;
      }

      step += 1;
    }
  } catch (error) {
    status = 'error';
    reason = redactor.string(error instanceof Error ? error.message : String(error));
  } finally {
    await close();
  }

  return finish();
}
