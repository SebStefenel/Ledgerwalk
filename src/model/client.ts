import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageParam, Tool, ToolChoice } from '@anthropic-ai/sdk/resources/messages';

import type { TokenUsage } from '../trace/logger.js';

/** Overridable so a cheaper model can drive long runs. */
export const DEFAULT_MODEL = process.env['LEDGERWALK_MODEL'] ?? 'claude-opus-5';

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1_000;

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { readonly status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

function retryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('headers' in error)) return null;
  const headers = (error as { readonly headers: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return null;
  const get = (headers as { readonly get?: (name: string) => string | null }).get;
  const raw = typeof get === 'function' ? get.call(headers, 'retry-after') : null;
  if (raw === null || raw === undefined) return null;
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) ? seconds * 1_000 : null;
}

function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== null) return RETRY_STATUSES.has(status);
  // Connection resets and timeouts carry no status; those are worth one more try.
  return error instanceof Error && /econn|timeout|network|socket|fetch failed/i.test(error.message);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ModelCallOptions {
  readonly system: string;
  readonly messages: readonly MessageParam[];
  readonly tools: readonly Tool[];
  readonly toolChoice?: ToolChoice;
  readonly maxTokens?: number;
}

/**
 * What the agent loop actually needs from a model. Depending on this rather than
 * the concrete client lets the loop be driven by a scripted stand-in in tests.
 */
export interface ModelSender {
  readonly tokens: TokenUsage;
  send: (options: ModelCallOptions) => Promise<Message>;
}

/**
 * Thin wrapper over the Messages API: our own retry policy on 429/5xx, and a
 * running token count for the whole process.
 */
export class ModelClient implements ModelSender {
  readonly #client: Anthropic;
  readonly model: string;
  #input = 0;
  #output = 0;
  #calls = 0;

  constructor(options: { readonly apiKey?: string; readonly model?: string } = {}) {
    const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey === '') {
      throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env before running the agent.');
    }
    // Our own retry loop below; the SDK's would hide the attempts from the trace.
    this.#client = new Anthropic({ apiKey, maxRetries: 0 });
    this.model = options.model ?? DEFAULT_MODEL;
  }

  get tokens(): TokenUsage {
    return { input: this.#input, output: this.#output };
  }

  get calls(): number {
    return this.#calls;
  }

  async send(options: ModelCallOptions): Promise<Message> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const message = await this.#client.messages.create({
          model: this.model,
          max_tokens: options.maxTokens ?? 1_024,
          system: options.system,
          messages: [...options.messages],
          tools: [...options.tools],
          ...(options.toolChoice === undefined ? {} : { tool_choice: options.toolChoice }),
        });
        this.#calls += 1;
        this.#input += message.usage.input_tokens;
        this.#output += message.usage.output_tokens;
        return message;
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS || !isRetryable(error)) break;
        const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
        const jitter = Math.random() * 250;
        await sleep(retryAfterMs(error) ?? backoff + jitter);
      }
    }

    const status = statusOf(lastError);
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`model call failed${status === null ? '' : ` (HTTP ${status})`}: ${detail}`);
  }
}
