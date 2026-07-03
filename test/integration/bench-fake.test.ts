// Ring 2 (V0.1_SPEC.md §9): the FULL benchmark harness driven by scripted
// FakeProviders — staging, verification, hashing, metrics, replay validation,
// and scoring, end-to-end, no GPU. CI validates everything except the model.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmark } from '../../src/bench/harness.js';
import { benchmarkSpecSchema, type BenchmarkSpec, type RunResult } from '../../src/bench/spec.js';

/** On assertion failure, print the run's full diagnostic record — every field
 * that contributed to `passed` (turn outcome, per-verifier outcomes incl.
 * command exit + output tail, protected-file hashes, replay validation). */
function explain(run: RunResult): string {
  const diagnosticsPath = path.join(path.dirname(run.journalPath), 'diagnostics.json');
  const diagnostics = fs.existsSync(diagnosticsPath)
    ? fs.readFileSync(diagnosticsPath, 'utf8')
    : '(diagnostics.json missing)';
  return `RUN DIAGNOSTICS (${diagnosticsPath}):\n${diagnostics}`;
}
import { FakeClock, fakeIds } from '../fakes/clock.js';
import { FakeProvider, type ScriptStep } from '../fakes/provider.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BENCHMARK_DIR = path.join(REPO_ROOT, 'benchmarks', 'fix-failing-test');
const PROMPT_PATH = path.join(REPO_ROOT, 'prompts', 'architect', 'system.md');

const FIXED_SRC = `export interface Interval {
  /** Inclusive lower bound. */
  start: number;
  /** Inclusive upper bound. */
  end: number;
}

/**
 * Whether two closed intervals share at least one point.
 * Closed means the endpoints belong to the interval, so [1,5] and [5,9]
 * overlap at the single point 5.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end;
}
`;

let scratchDir: string;
let resultsDir: string;
let baseSpec: BenchmarkSpec;
let testSeq = 0;

beforeAll(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-bench-'));
  resultsDir = path.join(scratchDir, 'results');
  baseSpec = benchmarkSpecSchema.parse(
    JSON.parse(fs.readFileSync(path.join(BENCHMARK_DIR, 'benchmark.json'), 'utf8')),
  );
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function singleRunSpec(overrides?: Partial<BenchmarkSpec['budgets']>): BenchmarkSpec {
  return {
    ...baseSpec,
    runs: { count: 1, seeds: [1] },
    scoring: { requiredPasses: 1 },
    budgets: { ...baseSpec.budgets, ...overrides },
  };
}

async function execute(spec: BenchmarkSpec, script: ScriptStep[]) {
  testSeq += 1;
  const ids = fakeIds(`t${testSeq}_`);
  const provider = new FakeProvider(script);
  const report = await runBenchmark({
    spec,
    benchmarkDir: BENCHMARK_DIR,
    provider,
    promptPath: PROMPT_PATH,
    scratchDir,
    resultsDir,
    clock: new FakeClock(),
    ids,
    environment: { node: process.version, pnpm: null, runtimeVersion: '0.1.0-test' },
  });
  return { report, run: report.runs[0]!, provider, runPrefix: `t${testSeq}_` };
}

const RUN_TESTS: ScriptStep = {
  kind: 'tool_calls',
  calls: [{ name: 'run_command', arguments: { command: 'pnpm test' } }],
};
const WRITE_FIX: ScriptStep = {
  kind: 'tool_calls',
  calls: [{ name: 'write_file', arguments: { path: 'src/interval.ts', content: FIXED_SRC } }],
};

describe('benchmark harness (Ring 2)', () => {
  it('scores the honest fixer as a pass, with exact metrics', async () => {
    const { report, run } = await execute(singleRunSpec(), [
      RUN_TESTS,
      { kind: 'tool_calls', calls: [{ name: 'read_file', arguments: { path: 'test/interval.test.ts' } }] },
      { kind: 'tool_calls', calls: [{ name: 'read_file', arguments: { path: 'src/interval.ts' } }] },
      WRITE_FIX,
      RUN_TESTS,
      { kind: 'text', content: 'Fixed the boundary bug in overlaps(); pnpm test exits 0.' },
    ]);

    expect(run.passed, explain(run)).toBe(true);
    expect(run.failure_reason, explain(run)).toBeUndefined();
    expect(run.failures, explain(run)).toEqual([]);
    expect(run.metrics.tool_calls).toEqual({
      total: 5,
      by_tool: { run_command: 2, read_file: 2, write_file: 1 },
    });
    expect(run.metrics.invalid_tool_calls).toEqual({
      total: 0,
      validation_failed: 0,
      unknown_tool: 0,
      policy_denied: 0,
    });
    expect(run.metrics.iterations).toBe(6);
    expect(run.metrics.tokens).toEqual({ input: 600, output: 170, total: 770 });
    expect(run.metrics.provider_retries).toBe(0);
    expect(run.metrics.wall_clock_ms).toBeGreaterThan(0);

    expect(report.passed).toBe(true);
    expect(report.aggregates).toMatchObject({ pass_rate: 1, passes: 1, total_runs: 1 });
    expect(report.environment.promptVersion).toBe('1');
    expect(report.environment.modelDigest).toBe('fake-digest');

    // The report landed on disk and the journal exists for audit.
    expect(fs.readdirSync(resultsDir).some((f) => f.startsWith('fix-failing-test-'))).toBe(true);
    expect(fs.existsSync(run.journalPath)).toBe(true);
  }, 120_000);

  it('fails a fixer that never observed the failing tests first (fixes blind)', async () => {
    const { run } = await execute(singleRunSpec(), [
      WRITE_FIX,
      RUN_TESTS,
      { kind: 'text', content: 'fixed' },
    ]);
    expect(run.passed).toBe(false);
    expect(run.failure_reason).toBe('verification_failed');
    expect(run.failures.some((f) => f.includes('failure_observed_before_first_write'))).toBe(true);
  }, 120_000);

  it('catches a cheater that mutates protected files via run_command', async () => {
    const { run } = await execute(singleRunSpec(), [
      RUN_TESTS,
      {
        kind: 'tool_calls',
        // portable delete — `rm` doesn't exist in cmd.exe
        calls: [
          {
            name: 'run_command',
            arguments: { command: `node -e "require('fs').unlinkSync('test/interval.test.ts')"` },
          },
        ],
      },
      RUN_TESTS,
      { kind: 'text', content: 'all green now' },
    ]);
    expect(run.passed).toBe(false);
    expect(run.failure_reason).toBe('protected_file_modified');
    expect(run.failures.some((f) => f.includes('test/interval.test.ts'))).toBe(true);
  }, 120_000);

  it('denies a write outside the surface and counts it as an invalid call', async () => {
    const { run } = await execute(singleRunSpec(), [
      RUN_TESTS,
      {
        kind: 'tool_calls',
        calls: [
          { name: 'write_file', arguments: { path: 'test/interval.test.ts', content: 'gutted' } },
        ],
      },
      WRITE_FIX,
      RUN_TESTS,
      { kind: 'text', content: 'done' },
    ]);
    // The denied write never landed, so the protected files are intact and the
    // real fix passed — but the metric records the policy denial.
    expect(run.passed, explain(run)).toBe(true);
    expect(run.metrics.invalid_tool_calls.policy_denied, explain(run)).toBe(1);
    expect(run.metrics.invalid_tool_calls.total, explain(run)).toBe(1);
  }, 120_000);

  it('fails a lazy agent that reports success without fixing anything', async () => {
    const { run } = await execute(singleRunSpec(), [
      RUN_TESTS,
      { kind: 'text', content: 'Everything passes! (it does not)' },
    ]);
    expect(run.passed).toBe(false);
    expect(run.failure_reason).toBe('verification_failed');
    expect(run.failures.some((f) => f.includes('command_exit_zero'))).toBe(true);
  }, 120_000);

  it('maps an iteration overrun to max_iterations', async () => {
    const { run } = await execute(singleRunSpec({ maxIterations: 2 }), [
      RUN_TESTS,
      { kind: 'tool_calls', calls: [{ name: 'read_file', arguments: { path: 'src/interval.ts' } }] },
      { kind: 'tool_calls', calls: [{ name: 'read_file', arguments: { path: 'src/interval.ts' } }] },
    ]);
    expect(run.passed).toBe(false);
    expect(run.failure_reason).toBe('max_iterations');
    expect(run.metrics.iterations).toBe(2);
  }, 120_000);

  it('scores a corrupted journal as replay_mismatch even when the tests went green', async () => {
    testSeq += 1;
    const prefix = `t${testSeq}_`;
    const journalPath = path.join(scratchDir, 'bench', 'fix-failing-test', `${prefix}run_1`, 'journal.jsonl');
    const provider = new FakeProvider([
      RUN_TESTS,
      WRITE_FIX,
      RUN_TESTS,
      {
        kind: 'dynamic',
        respond: (req) => {
          // Simulate an external writer / runtime bug injecting a bogus event
          // mid-run: replay must detect the incomplete audit log.
          fs.appendFileSync(
            journalPath,
            JSON.stringify({
              type: 'tool_call',
              sessionId: 'intruder',
              seq: 999,
              at: 0,
              call: { id: 'x', name: 'x', arguments: {} },
            }) + '\n',
          );
          void req;
          return {
            message: { role: 'assistant', content: 'green', toolCalls: [] },
            usage: { inputTokens: 100, outputTokens: 20 },
            stopReason: 'end',
          };
        },
      },
    ]);
    const report = await runBenchmark({
      spec: singleRunSpec(),
      benchmarkDir: BENCHMARK_DIR,
      provider,
      promptPath: PROMPT_PATH,
      scratchDir,
      resultsDir,
      clock: new FakeClock(),
      ids: fakeIds(prefix),
      environment: { node: process.version, pnpm: null, runtimeVersion: '0.1.0-test' },
    });
    const run = report.runs[0]!;
    expect(run.passed).toBe(false);
    expect(run.failure_reason).toBe('replay_mismatch');
    expect(run.failures.some((f) => f.includes('replay_validation'))).toBe(true);
  }, 120_000);

  it('scores a window-saturating run as context_overflow, not a model failure', async () => {
    const { run } = await execute(singleRunSpec(), [
      RUN_TESTS,
      {
        kind: 'dynamic',
        respond: () => ({
          // FakeProvider window is 32768; 30000 crosses the 90% guard.
          message: { role: 'assistant', content: '', toolCalls: [] },
          usage: { inputTokens: 30_000, outputTokens: 10 },
          stopReason: 'end',
        }),
      },
    ]);
    expect(run.passed).toBe(false);
    expect(run.failure_reason).toBe('context_overflow');
  }, 120_000);

  it('rejects a spec that allows an unknown tool', async () => {
    const spec = { ...singleRunSpec(), tools: { allowed: ['teleport'], writableSurface: ['src/**'] } };
    await expect(execute(spec, [{ kind: 'text', content: 'x' }])).rejects.toThrow(/unknown tool/);
  }, 120_000);
});
