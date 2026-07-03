import { describe, expect, it } from 'vitest';
import { fromWireResponse, toWireMessages, toWireTools } from '../../src/providers/ollama/translate.js';
import type { RuntimeMessage } from '../../src/core/messages.js';
import { fakeIds } from '../fakes/clock.js';

describe('toWireMessages', () => {
  it('translates the full role set', () => {
    const messages: RuntimeMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'calling',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'file body' },
      { role: 'assistant', content: 'done', toolCalls: [] },
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }],
      },
      { role: 'tool', content: 'file body', tool_name: 'read_file' },
      { role: 'assistant', content: 'done' }, // no empty tool_calls array
    ]);
  });
});

describe('toWireTools', () => {
  it('wraps JSON Schemas in the function envelope', () => {
    const wire = toWireTools([
      { name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } },
    ]);
    expect(wire).toEqual([
      {
        type: 'function',
        function: { name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } },
      },
    ]);
  });
});

describe('fromWireResponse', () => {
  // Shape captured from a real Ollama /api/chat qwen3 tool-call response.
  it('parses a tool-call response, minting call ids', () => {
    const { message, usage, stopReason } = fromWireResponse(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'run_command', arguments: { command: 'pnpm test' } } }],
        },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 812,
        eval_count: 44,
      },
      fakeIds(),
    );
    expect(message.toolCalls).toEqual([
      { id: 'call_1', name: 'run_command', arguments: { command: 'pnpm test' } },
    ]);
    expect(usage).toEqual({ inputTokens: 812, outputTokens: 44 });
    expect(stopReason).toBe('tool_calls');
  });

  it('parses a plain text response', () => {
    const { message, stopReason } = fromWireResponse(
      { message: { role: 'assistant', content: 'All tests pass now.' }, done_reason: 'stop' },
      fakeIds(),
    );
    expect(message.content).toBe('All tests pass now.');
    expect(message.toolCalls).toEqual([]);
    expect(stopReason).toBe('end');
  });

  it('parses string arguments defensively and flags max_tokens', () => {
    const { message, stopReason } = fromWireResponse(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'grep', arguments: '{"pattern":"x"}' } }],
        },
        done_reason: 'length',
      },
      fakeIds(),
    );
    expect(message.toolCalls[0]?.arguments).toEqual({ pattern: 'x' });
    expect(stopReason).toBe('tool_calls');
  });

  it('drops malformed tool calls without a name', () => {
    const { message } = fromWireResponse(
      { message: { role: 'assistant', content: 'x', tool_calls: [{ function: {} }] } },
      fakeIds(),
    );
    expect(message.toolCalls).toEqual([]);
  });
});
