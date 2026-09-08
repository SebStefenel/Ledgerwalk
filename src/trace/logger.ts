import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { AgentAction } from '../stage2/actions.js';

/* --------------------------------------------------------------- redactor */

/** Env vars whose values are secret by nature, whatever the service. */
const SECRET_KEY_PATTERN = /(PASSWORD|PASSWD|SECRET|TOKEN|TOTP|API_?KEY|COOKIE|SESSION|PRIVATE|CREDENTIAL)/i;

/** Below this length a "secret" would match too much ordinary text to redact safely. */
const MIN_REDACTABLE_LENGTH = 4;

const PLACEHOLDER = '[REDACTED]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces known secret values with a placeholder anywhere they appear.
 *
 * Everything written to disk goes through this, so a secret cannot reach a trace
 * even if some future code path puts one in a message by accident. Defence in
 * depth: the model is never given a value in the first place.
 */
export class Redactor {
  readonly #secrets = new Set<string>();

  /** Seed from the environment: every value whose key name looks secret. */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): Redactor {
    const redactor = new Redactor();
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined && SECRET_KEY_PATTERN.test(key)) redactor.add(value);
    }
    return redactor;
  }

  add(secret: string | undefined): void {
    if (secret === undefined) return;
    const trimmed = secret.trim();
    if (trimmed.length < MIN_REDACTABLE_LENGTH) return;
    this.#secrets.add(trimmed);
  }

  get size(): number {
    return this.#secrets.size;
  }

  string(text: string): string {
    let output = text;
    // Longest first, so a secret that contains another is replaced whole.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      output = output.replace(new RegExp(escapeRegExp(secret), 'gi'), PLACEHOLDER);
    }
    return output;
  }

  /** Deep-redact any JSON-shaped value, keys included. */
  value(input: unknown): unknown {
    if (typeof input === 'string') return this.string(input);
    if (Array.isArray(input)) return input.map((item) => this.value(item));
    if (typeof input === 'object' && input !== null) {
      const output: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        output[this.string(key)] = this.value(value);
      }
      return output;
    }
    return input;
  }
}

/* ------------------------------------------------------------ trace shapes */

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
}

export interface StepOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** set when a guard refused the action before it ran */
  readonly blockedBy: string | null;
}

export interface TraceStep {
  readonly step: number;
  readonly timestamp: string;
  readonly url: string;
  /** stable hash of the observation, so repeat states are visible in the trace */
  readonly observationHash: string;
  readonly action: AgentAction | null;
  /** set when the model's tool call could not be parsed */
  readonly parseError: string | null;
  readonly result: StepOutcome;
  readonly latencyMs: number;
  readonly tokens: TokenUsage;
  readonly screenshot: string | null;
}

export type TaskStatus =
  | 'extracted'
  | 'gave_up'
  | 'step_limit'
  | 'auth_expired'
  | 'stopped_at_cancel'
  | 'dry_run'
  | 'error';

export interface TaskResult {
  readonly service: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly fields: Readonly<Record<string, string>> | null;
  readonly reason: string;
  readonly steps: number;
  readonly tokens: TokenUsage;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** Written to every trace dir so the eval harness can read it without this code. */
const TRACE_FORMAT = {
  format: 'ledgerwalk-trace',
  version: 1,
  files: {
    'meta.json': 'this file: format version, service, goal, run settings',
    'trace.jsonl': 'one JSON object per step; see stepSchema below',
    'result.json': 'final TaskResult: status, extracted fields, token totals',
    'step-NN.png': 'screenshot taken after step NN',
    'blocks.jsonl': 'one JSON object per guard block (absent if nothing was blocked)',
    'playwright-trace.zip': "Playwright's own trace, open with `npx playwright show-trace`",
  },
  stepSchema: {
    step: 'integer, 1-based',
    timestamp: 'ISO 8601',
    url: 'page URL at observation time',
    observationHash: 'sha256 of the page representation, first 16 hex chars',
    action: 'the executed action, or null if the tool call failed to parse',
    parseError: 'string or null',
    result: '{ ok, message, blockedBy }',
    latencyMs: 'integer, model call + execution',
    tokens: '{ input, output }',
    screenshot: 'file name or null',
  },
  note: 'All strings pass through a redactor before being written. Secrets never enter this directory.',
} as const;

/* ----------------------------------------------------------------- logger */

export function hashObservation(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

export class TraceLogger {
  readonly dir: string;
  readonly #redactor: Redactor;

  private constructor(dir: string, redactor: Redactor) {
    this.dir = dir;
    this.#redactor = redactor;
  }

  static create(options: {
    readonly service: string;
    readonly goal: string;
    readonly url: string;
    readonly maxSteps: number;
    readonly dryRun: boolean;
    readonly redactor: Redactor;
    readonly root?: string;
  }): TraceLogger {
    const root = options.root ?? 'traces';
    const slug = options.service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dir = resolve(join(root, `${slug}-${stamp(new Date())}`));
    mkdirSync(dir, { recursive: true });

    const logger = new TraceLogger(dir, options.redactor);
    logger.#write(
      'meta.json',
      JSON.stringify(
        {
          ...TRACE_FORMAT,
          service: options.service,
          goal: options.goal,
          url: options.url,
          maxSteps: options.maxSteps,
          dryRun: options.dryRun,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return logger;
  }

  #write(name: string, contents: string): void {
    writeFileSync(join(this.dir, name), `${this.#redactor.string(contents)}\n`, 'utf8');
  }

  /** File name a screenshot for this step should use. */
  screenshotName(step: number): string {
    return `step-${String(step).padStart(2, '0')}.png`;
  }

  screenshotPath(step: number): string {
    return join(this.dir, this.screenshotName(step));
  }

  get playwrightTracePath(): string {
    return join(this.dir, 'playwright-trace.zip');
  }

  step(entry: TraceStep): void {
    const line = JSON.stringify(this.#redactor.value(entry));
    appendFileSync(join(this.dir, 'trace.jsonl'), `${line}\n`, 'utf8');
  }

  /** Every block is recorded, whether or not it changed the outcome. */
  blocked(step: number, rule: string, action: AgentAction): void {
    appendFileSync(
      join(this.dir, 'blocks.jsonl'),
      `${JSON.stringify(this.#redactor.value({ step, rule, action, at: new Date().toISOString() }))}\n`,
      'utf8',
    );
  }

  finish(result: TaskResult): void {
    this.#write('result.json', JSON.stringify(result, null, 2));
  }
}
