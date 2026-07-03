// Injected effects (ARCHITECTURE.md constraint #4): core paths never touch the
// wall clock or ambient randomness. Real implementations are wired in host/;
// tests use test/fakes.

export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
  /** Resolves after ms; rejects with AbortError if the signal fires first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface IdGen {
  /** Returns a unique id with the given prefix, e.g. `run_01h...`. */
  next(prefix: string): string;
}

export interface Rng {
  /** Uniform float in [0, 1). */
  float(): number;
}
