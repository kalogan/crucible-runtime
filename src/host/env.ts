// The composition root's real effects: wall clock, ids, randomness. This is
// the ONLY module (with cli.ts/config.ts) allowed to touch them — everything
// below takes them injected (ARCHITECTURE.md constraint #4).

import { randomUUID } from 'node:crypto';
import type { Clock, IdGen, Rng } from '../core/inject.js';

export function realClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
  };
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export function realIdGen(): IdGen {
  let n = 0;
  return {
    next: (prefix) => `${prefix}_${(++n).toString(36).padStart(3, '0')}_${randomUUID().slice(0, 8)}`,
  };
}

export function realRng(): Rng {
  return { float: () => Math.random() };
}
