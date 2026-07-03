import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentSession } from '../../src/core/session.js';
import type { RuntimeEvent } from '../../src/core/events.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ok } from '../../src/tools/types.js';
import type { Tool } from '../../src/tools/types.js';
import { ProviderError } from '../../src/core/errors.js';
import { FakeClock, fakeIds } from '../fakes/clock.js';
import { FakeProvider, type ScriptStep } from '../fakes/provider.js';

const echoTool: Tool<{ text: string }, { echoed: string }> = {
  name: 'echo',
  description: 'echo the input',
  inputSchema: z.object({ text: z.string() }),
  safety: 'safe',
  parallelSafe: true,
  timeoutMs: 5_000,
  async execute(input) {
    return ok({ echoed: input.text }, `echo: ${input.text}`);
  },
};

function makeSession(script: ScriptStep[], overrides?: { maxIterations?: number; wallClockMs?: number }) {
  const events: RuntimeEvent[] = [];
  const provider = new FakeProvider(script);
  const registry = new ToolRegistry().register(echoTool);
  const session = AgentSession.create({
    role: 'test',
    systemPrompt: 'You are a test agent.',
    provider,
    model: 'fake-model',
    contextWindow: 32_768,
    chatOptions: {},
    tools: registry,
    workspace: '/tmp/nonexistent-ws',
    budgets: {
      maxIterations: overrides?.maxIterations ?? 10,
      wallClockMs: overrides?.wallClockMs ?? 3_600_000,
    },
    clock: new FakeClock(),
    ids: fakeIds(),
    sink: (e) => events.push(structuredClone(e)),
  });
  return { session, events, provider };
}

describe('runTurn', () => {
  it('completes on a plain text response', async () => {
    const { session, events } = makeSession([{ kind: 'text', content: 'hello' }]);
    const result = await session.runTurn('hi');
    expect(result.outcome).toBe('completed');
    expect(result.finalText).toBe('hello');
    expect(result.iterations).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(events.map((e) => e.type)).toEqual([
      'turn_started',
      'infer_request',
      'infer_response',
      'turn_finished',
    ]);
  });

  it('executes a tool round then completes; results are appended in order', async () => {
    const { session, provider } = makeSession([
      { kind: 'tool_calls', calls: [{ name: 'echo', arguments: { text: 'a' } }] },
      { kind: 'text', content: 'done' },
    ]);
    const result = await session.runTurn('go');
    expect(result.outcome).toBe('completed');
    expect(result.iterations).toBe(2);

    // Second request must contain assistant tool-call msg + tool result msg.
    const second = provider.requests[1]!;
    const roles = second.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    const toolMsg = second.messages[3]!;
    expect(toolMsg.role === 'tool' && toolMsg.content).toBe('echo: a');
  });

  it('returns an unknown-tool error to the model and lets it recover', async () => {
    const { session, events } = makeSession([
      { kind: 'tool_calls', calls: [{ name: 'nope', arguments: {} }] },
      { kind: 'text', content: 'recovered' },
    ]);
    const result = await session.runTurn('go');
    expect(result.outcome).toBe('completed');
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.ok).toBe(false);
    expect(toolResult?.type === 'tool_result' && toolResult.errorKind).toBe('unknown_tool');
    expect(toolResult?.type === 'tool_result' && toolResult.message.content).toContain('echo');
  });

  it('returns a validation error naming the bad field', async () => {
    const { session, events } = makeSession([
      { kind: 'tool_calls', calls: [{ name: 'echo', arguments: { text: 42 } }] },
      { kind: 'text', content: 'fixed' },
    ]);
    await session.runTurn('go');
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.errorKind).toBe('validation_failed');
    expect(toolResult?.type === 'tool_result' && toolResult.message.content).toContain('text');
  });

  it('stops at max iterations', async () => {
    const looping: ScriptStep[] = Array.from({ length: 5 }, () => ({
      kind: 'tool_calls' as const,
      calls: [{ name: 'echo', arguments: { text: 'again' } }],
    }));
    const { session } = makeSession(looping, { maxIterations: 3 });
    const result = await session.runTurn('go');
    expect(result.outcome).toBe('max_iterations');
    expect(result.iterations).toBe(3);
  });

  it('stops when the wall-clock budget is exhausted', async () => {
    const { session } = makeSession(
      [
        { kind: 'tool_calls', calls: [{ name: 'echo', arguments: { text: 'x' } }] },
        { kind: 'text', content: 'never reached' },
      ],
      { wallClockMs: 15 }, // FakeClock ticks 10ms per now() — exhausted after one round
    );
    const result = await session.runTurn('go');
    expect(result.outcome).toBe('budget_exceeded');
  });

  it('fails with context_overflow when the prompt reaches the window guard', async () => {
    const { session, events } = makeSession([
      {
        kind: 'dynamic',
        respond: () => ({
          // 32768 × 0.9 = 29491 — this response's prompt is over the guard.
          message: { role: 'assistant', content: 'half-blind answer', toolCalls: [] },
          usage: { inputTokens: 30_000, outputTokens: 10 },
          stopReason: 'end',
        }),
      },
    ]);
    const result = await session.runTurn('go');
    // Even a "completed-looking" response fails: it may have been computed on
    // a truncated context, so the run is invalid, not successful.
    expect(result.outcome).toBe('context_overflow');
    const error = events.find((e) => e.type === 'session_error');
    expect(error?.type === 'session_error' && error.message).toContain('context overflow');
  });

  it('ends the turn on provider failure after retries', async () => {
    const { session, events } = makeSession([
      { kind: 'error', error: new ProviderError({ kind: 'fatal', message: 'boom' }) },
    ]);
    const result = await session.runTurn('go');
    expect(result.outcome).toBe('provider_failed');
    expect(events.some((e) => e.type === 'session_error')).toBe(true);
  });

  it('journals write-ahead: every state-bearing message appears as an event first', async () => {
    const { session, events } = makeSession([
      { kind: 'tool_calls', calls: [{ name: 'echo', arguments: { text: 'a' } }] },
      { kind: 'text', content: 'done' },
    ]);
    await session.runTurn('go');
    const state = session.state();
    // Reconstruct from events only.
    const started = events.find((e) => e.type === 'turn_started');
    const rebuilt = started?.type === 'turn_started' ? [...started.messages] : [];
    for (const e of events) {
      if (e.type === 'infer_response') rebuilt.push(e.message);
      if (e.type === 'tool_result') rebuilt.push(e.message);
    }
    expect(rebuilt).toEqual(state.messages);
  });

  it('seq numbers are contiguous from 1', async () => {
    const { session, events } = makeSession([{ kind: 'text', content: 'hi' }]);
    await session.runTurn('go');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});
