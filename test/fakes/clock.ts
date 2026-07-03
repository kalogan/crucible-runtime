import type { Clock, IdGen, Rng } from '../../src/core/inject.js';

/**
 * Deterministic clock: now() advances by `tickMs` per call so durations are
 * nonzero and stable. sleep() records the requested delay; by default it
 * HANGS (like a real pending timer) so timeout races don't fire spuriously
 * against real async work — set hangSleeps=false where a test needs timers
 * to fire (retry backoff, executor-timeout).
 */
export class FakeClock implements Clock {
  private t: number;
  private readonly tickMs: number;
  readonly sleeps: number[] = [];
  /** When true (default), sleep() never resolves; rejects on abort. */
  hangSleeps = true;

  constructor(start = 1_000_000, tickMs = 10) {
    this.t = start;
    this.tickMs = tickMs;
  }

  now(): number {
    this.t += this.tickMs;
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    if (this.hangSleeps) {
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    if (signal?.aborted) throw abortError();
    this.t += ms;
    await Promise.resolve();
  }
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/** A FakeClock whose timers fire immediately — for backoff/timeout tests. */
export function firingClock(start?: number, tickMs?: number): FakeClock {
  const clock = new FakeClock(start, tickMs);
  clock.hangSleeps = false;
  return clock;
}

export function fakeIds(prefix = ''): IdGen {
  let n = 0;
  return { next: (p) => `${prefix}${p}_${++n}` };
}

export function fakeRng(value = 0.5): Rng {
  return { float: () => value };
}
