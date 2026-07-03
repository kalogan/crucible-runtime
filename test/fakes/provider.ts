import type {
  ChatRequest,
  ChatResponse,
  ModelCapabilities,
  Provider,
} from '../../src/providers/types.js';
import type { ToolCall } from '../../src/core/messages.js';

export type ScriptStep =
  | { kind: 'text'; content: string }
  | { kind: 'tool_calls'; calls: Array<Pick<ToolCall, 'name' | 'arguments'>>; content?: string }
  | { kind: 'error'; error: Error }
  | { kind: 'dynamic'; respond: (req: ChatRequest) => ChatResponse };

const CAPS: ModelCapabilities = {
  nativeTools: true,
  parallelToolCalls: true,
  contextWindow: 32_768,
  supportsSystemPrompt: true,
  promptCaching: 'none',
  sampling: { temperature: 0 },
};

/**
 * Scripted provider: returns the next step per chat() call. Separates
 * "runtime broken" from "model confused" — Ring 1/2 run entirely on this.
 */
export class FakeProvider implements Provider {
  readonly id = 'fake';
  readonly requests: ChatRequest[] = [];
  private cursor = 0;
  private callSeq = 0;

  constructor(private readonly script: ScriptStep[]) {}

  capabilities(): ModelCapabilities {
    return CAPS;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    const step = this.script[this.cursor];
    if (step === undefined) {
      throw new Error(`FakeProvider script exhausted after ${this.cursor} steps`);
    }
    this.cursor += 1;
    switch (step.kind) {
      case 'error':
        throw step.error;
      case 'dynamic':
        return step.respond(req);
      case 'text':
        return {
          message: { role: 'assistant', content: step.content, toolCalls: [] },
          usage: { inputTokens: 100, outputTokens: 20 },
          stopReason: 'end',
        };
      case 'tool_calls':
        return {
          message: {
            role: 'assistant',
            content: step.content ?? '',
            toolCalls: step.calls.map((c) => ({ ...c, id: `fcall_${++this.callSeq}` })),
          },
          usage: { inputTokens: 100, outputTokens: 30 },
          stopReason: 'tool_calls',
        };
    }
  }

  async modelDigest(): Promise<string | null> {
    return 'fake-digest';
  }
}
