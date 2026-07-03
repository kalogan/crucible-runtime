// One retry discipline at the adapter boundary, never sprinkled at call sites
// (KERNEL_LESSONS §3): exponential backoff + jitter, Retry-After honored,
// 429/5xx/connection failures retryable.

import type { Clock, Rng } from '../core/inject.js';
import { ProviderError } from '../core/errors.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

export interface RetryDeps {
  clock: Clock;
  rng: Rng;
  signal?: AbortSignal | undefined;
  onRetry?: ((attempt: number, delayMs: number, reason: string) => void) | undefined;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  deps: RetryDeps,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError && err.kind === 'retryable';
      if (!retryable || attempt === policy.maxAttempts) throw err;

      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.round(backoff * (0.5 + deps.rng.float() * 0.5));
      const delayMs =
        err.retryAfterMs !== undefined ? Math.min(policy.maxDelayMs, err.retryAfterMs) : jittered;
      deps.onRetry?.(attempt, delayMs, err.message);
      await deps.clock.sleep(delayMs, deps.signal);
    }
  }
  throw lastError;
}
