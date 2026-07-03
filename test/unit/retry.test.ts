import { describe, expect, it } from 'vitest';
import { withRetry } from '../../src/providers/retry.js';
import { ProviderError } from '../../src/core/errors.js';
import { firingClock, fakeRng } from '../fakes/clock.js';

const retryable = (msg = '503') => new ProviderError({ kind: 'retryable', message: msg });

describe('withRetry', () => {
  it('returns on first success without sleeping', async () => {
    const clock = firingClock();
    const result = await withRetry(async () => 'ok', { clock, rng: fakeRng() });
    expect(result).toBe('ok');
    expect(clock.sleeps).toEqual([]);
  });

  it('backs off exponentially with jitter and eventually succeeds', async () => {
    const clock = firingClock();
    let attempts = 0;
    const retries: Array<[number, number]> = [];
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 4) throw retryable();
        return 'finally';
      },
      { clock, rng: fakeRng(0.5), onRetry: (a, d) => retries.push([a, d]) },
    );
    expect(result).toBe('finally');
    // base 1000, factor 2^n, jitter at rng 0.5 → 0.75×
    expect(clock.sleeps).toEqual([750, 1_500, 3_000]);
    expect(retries.map(([a]) => a)).toEqual([1, 2, 3]);
  });

  it('honors Retry-After over computed backoff', async () => {
    const clock = firingClock();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ProviderError({ kind: 'retryable', message: '429', retryAfterMs: 5_000 });
        }
        return 'ok';
      },
      { clock, rng: fakeRng() },
    );
    expect(clock.sleeps).toEqual([5_000]);
  });

  it('does not retry fatal errors', async () => {
    const clock = firingClock();
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new ProviderError({ kind: 'fatal', message: '400' });
        },
        { clock, rng: fakeRng() },
      ),
    ).rejects.toThrow('400');
    expect(attempts).toBe(1);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const clock = firingClock();
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw retryable(`fail-${attempts}`);
        },
        { clock, rng: fakeRng() },
        { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      ),
    ).rejects.toThrow('fail-3');
    expect(attempts).toBe(3);
    expect(clock.sleeps).toEqual([75, 150]);
  });
});
