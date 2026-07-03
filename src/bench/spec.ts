// BenchmarkSpec / RunResult / BenchmarkReport (V0.1_SPEC.md §8). The harness
// contains zero benchmark-specific code — everything that varies lives here,
// declaratively. New verifier kinds are additive union members.

import { z } from 'zod';

export const SPEC_VERSION = 1;
export const REPORT_VERSION = 1;

const samplingSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().int().optional(),
});

const verifierSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command_exit_zero'),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(600_000),
  }),
  z.object({
    kind: z.literal('files_unchanged'),
    /** Workspace-relative picomatch globs, hashed before/after the run. */
    paths: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('file_exists'),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('transcript_assert'),
    assert: z.enum(['failure_observed_before_first_write']),
  }),
]);

export type Verifier = z.infer<typeof verifierSchema>;

export const benchmarkSpecSchema = z.object({
  specVersion: z.literal(SPEC_VERSION),
  id: z.string().min(1),
  description: z.string(),
  fixture: z.object({
    /** Relative to the benchmark directory. */
    path: z.string().min(1),
    setupCommand: z.string().optional(),
  }),
  task: z.object({
    /** The user-turn brief; supports {{placeholder}} interpolation. */
    briefTemplate: z.string().min(1),
  }),
  model: z.object({
    pin: z.string().min(1),
    sampling: samplingSchema.optional(),
  }),
  runs: z.object({
    count: z.number().int().min(1),
    seeds: z.array(z.number().int()).min(1),
  }),
  budgets: z.object({
    maxIterations: z.number().int().min(1),
    wallClockMs: z.number().int().min(1_000),
  }),
  tools: z.object({
    allowed: z.array(z.string().min(1)).min(1),
    writableSurface: z.array(z.string().min(1)).min(1),
  }),
  scoring: z.object({
    /** Runs that must pass for the benchmark to pass (Director: ≥4 of 5). */
    requiredPasses: z.number().int().min(1),
  }),
  verifiers: z.array(verifierSchema).min(1),
});

export type BenchmarkSpec = z.infer<typeof benchmarkSpecSchema>;

export const failureReasonSchema = z.enum([
  'verification_failed',
  'protected_file_modified',
  'max_iterations',
  'wall_clock_exceeded',
  'provider_failed',
  'replay_mismatch',
  'aborted',
  // Ring-3 integrity guard (spec amendment A1): the assembled context reached
  // the model's window — the run is invalid, not a model failure.
  'context_overflow',
]);

export type FailureReason = z.infer<typeof failureReasonSchema>;

export const runMetricsSchema = z.object({
  tool_calls: z.object({
    total: z.number().int(),
    by_tool: z.record(z.number().int()),
  }),
  invalid_tool_calls: z.object({
    total: z.number().int(),
    validation_failed: z.number().int(),
    unknown_tool: z.number().int(),
    policy_denied: z.number().int(),
  }),
  provider_retries: z.number().int(),
  tokens: z.object({
    input: z.number().int(),
    output: z.number().int(),
    total: z.number().int(),
  }),
  wall_clock_ms: z.number().int(),
  iterations: z.number().int(),
});

export type RunMetrics = z.infer<typeof runMetricsSchema>;

export const runResultSchema = z.object({
  runId: z.string(),
  seed: z.number().int(),
  passed: z.boolean(),
  failure_reason: failureReasonSchema.optional(),
  /** Human-readable details for each failed verifier / check. */
  failures: z.array(z.string()),
  metrics: runMetricsSchema,
  journalPath: z.string(),
});

export type RunResult = z.infer<typeof runResultSchema>;

const aggregateSchema = z.object({ min: z.number(), median: z.number(), max: z.number() });

export const benchmarkReportSchema = z.object({
  reportVersion: z.literal(REPORT_VERSION),
  benchmarkId: z.string(),
  passed: z.boolean(),
  startedAtMs: z.number(),
  finishedAtMs: z.number(),
  environment: z.object({
    providerId: z.string(),
    model: z.string(),
    modelDigest: z.string().nullable(),
    promptVersion: z.string(),
    fixtureHash: z.string(),
    seeds: z.array(z.number().int()),
    node: z.string(),
    pnpm: z.string().nullable(),
    runtimeVersion: z.string(),
  }),
  runs: z.array(runResultSchema),
  aggregates: z.object({
    pass_rate: z.number(),
    passes: z.number().int(),
    total_runs: z.number().int(),
    tokens_total: aggregateSchema,
    wall_clock_ms: aggregateSchema,
    iterations: aggregateSchema,
    tool_calls_total: aggregateSchema,
    invalid_tool_calls_total: aggregateSchema,
  }),
});

export type BenchmarkReport = z.infer<typeof benchmarkReportSchema>;

export function aggregate(values: number[]): { min: number; median: number; max: number } {
  if (values.length === 0) return { min: 0, median: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]! };
}
