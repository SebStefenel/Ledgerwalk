import type { Message } from '@anthropic-ai/sdk/resources/messages';

import type { ModelCallOptions, ModelSender } from '../../src/model/client.js';
import type { TokenUsage } from '../../src/trace/logger.js';

export interface ScriptedCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** A stand-in for the model that plays a fixed sequence of tool calls. */
export class ScriptedModel implements ModelSender {
  /** every call as it was sent, for asserting on prompts and tool wiring */
  readonly calls: ModelCallOptions[] = [];
  #index = 0;
  #input = 0;
  #output = 0;

  constructor(private readonly script: readonly ScriptedCall[]) {}

  get tokens(): TokenUsage {
    return { input: this.#input, output: this.#output };
  }

  /** The first user message of each call, as text. */
  get prompts(): string[] {
    return this.calls.map((call) => {
      const first = call.messages[0];
      const content = first === undefined ? '' : first.content;
      return typeof content === 'string' ? content : JSON.stringify(content);
    });
  }

  /** The final user message of each call, as text — the live request. */
  get lastPrompts(): string[] {
    return this.calls.map((call) => {
      const last = call.messages[call.messages.length - 1];
      if (last === undefined) return '';
      if (typeof last.content === 'string') return last.content;
      return last.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim();
    });
  }

  send(options: ModelCallOptions): Promise<Message> {
    this.calls.push(options);

    const call = this.script[Math.min(this.#index, this.script.length - 1)];
    this.#index += 1;
    if (call === undefined) throw new Error('empty script');

    this.#input += 100;
    this.#output += 10;

    return Promise.resolve({
      id: `msg_${this.#index}`,
      type: 'message',
      role: 'assistant',
      model: 'scripted',
      content: [{ type: 'tool_use', id: `tu_${this.#index}`, name: call.tool, input: call.input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
      },
    } as Message);
  }
}
