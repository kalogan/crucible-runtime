// Error taxonomy (V0.1_SPEC.md §3). Tool-level failures are NOT errors — they
// return to the model as tool-result messages. Only infrastructure failures
// travel as exceptions, and they carry a kind the loop can act on.

export type ErrorKind = 'retryable' | 'fatal' | 'timeout' | 'aborted';

export class CrucibleError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CrucibleError';
    this.kind = kind;
  }
}

export class ProviderError extends CrucibleError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    kind: ErrorKind;
    message: string;
    status?: number;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(args.kind, args.message, { cause: args.cause });
    this.name = 'ProviderError';
    this.status = args.status;
    this.retryAfterMs = args.retryAfterMs;
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof CrucibleError && err.kind === 'aborted') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}
