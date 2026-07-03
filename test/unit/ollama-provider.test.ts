import { describe, expect, it } from 'vitest';
import { OllamaProvider } from '../../src/providers/ollama/provider.js';
import { firingClock, fakeIds, fakeRng } from '../fakes/clock.js';

function makeProvider(responses: Array<() => Response>) {
  let i = 0;
  const bodies: unknown[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    if (init?.body !== undefined) bodies.push(JSON.parse(init.body as string));
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return next();
  };
  const provider = new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    clock: firingClock(),
    ids: fakeIds(),
    rng: fakeRng(),
    fetchFn,
  });
  return { provider, bodies };
}

const okResponse = (): Response =>
  new Response(
    JSON.stringify({
      message: { role: 'assistant', content: 'hi' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 5,
    }),
    { status: 200 },
  );

const chatRequest = {
  model: 'qwen3:14b',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [],
  options: { seed: 7, signal: new AbortController().signal },
};

describe('OllamaProvider', () => {
  it('refuses a model with no capability entry (fail loud, not mid-turn)', () => {
    const { provider } = makeProvider([okResponse]);
    expect(() => provider.capabilities('mystery:7b')).toThrow(/capability entry/);
  });

  it('refuses a model whose entry says nativeTools: false', () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://x',
      clock: firingClock(),
      ids: fakeIds(),
      rng: fakeRng(),
      capabilityOverrides: { 'plain:1b': { nativeTools: false, contextWindow: 4_096 } },
    });
    expect(() => provider.capabilities('plain:1b')).toThrow(/native tool calling/);
  });

  it('sends num_ctx, think, seed, and sampling in the request body', async () => {
    const { provider, bodies } = makeProvider([okResponse]);
    await provider.chat({ ...chatRequest, options: { ...chatRequest.options, temperature: 0.6 } });
    expect(bodies[0]).toMatchObject({
      model: 'qwen3:14b',
      stream: false,
      think: true,
      options: { num_ctx: 16_384, seed: 7, temperature: 0.6 },
    });
  });

  it('retries a 500 then succeeds', async () => {
    const { provider } = makeProvider([
      () => new Response('overloaded', { status: 500 }),
      okResponse,
    ]);
    const response = await provider.chat(chatRequest);
    expect(response.message.content).toBe('hi');
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    };
    const provider = new OllamaProvider({
      baseUrl: 'http://x',
      clock: firingClock(),
      ids: fakeIds(),
      rng: fakeRng(),
      fetchFn,
    });
    await expect(provider.chat(chatRequest)).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('reads the model digest from /api/tags', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen3:14b', digest: 'abc123' }] }), {
        status: 200,
      });
    const provider = new OllamaProvider({
      baseUrl: 'http://x',
      clock: firingClock(),
      ids: fakeIds(),
      rng: fakeRng(),
      fetchFn,
    });
    expect(await provider.modelDigest('qwen3:14b')).toBe('abc123');
    expect(await provider.modelDigest('other')).toBe(null);
  });
});
