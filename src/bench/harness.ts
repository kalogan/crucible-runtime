// The benchmark harness (V0.1_SPEC.md §5.6): generic over any BenchmarkSpec.
// Stage fixture → run session → independently verify → replay-validate →
// collect metrics → score. It contains zero benchmark-specific code.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Clock, IdGen } from '../core/inject.js';
import type { RuntimeEvent } from '../core/events.js';
import type { TurnResult } from '../core/loop.js';
import { AgentSession } from '../core/session.js';
import type { Provider } from '../providers/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/types.js';
import { readFile, listDir, grep, writeFile, runCommand } from '../tools/builtin/index.js';
import { createTranscriptWriter, readJournal } from '../host/transcript.js';
import { loadPrompt, interpolate } from './prompt.js';
import {
  aggregate,
  REPORT_VERSION,
  type BenchmarkReport,
  type BenchmarkSpec,
  type FailureReason,
  type RunMetrics,
  type RunResult,
} from './spec.js';
import {
  hashFiles,
  hashTree,
  headTail,
  inspectInstalledTree,
  runGateCommand,
  runVerifiers,
  validateReplay,
} from './verify.js';

/** Packages whose presence/link-topology the diagnostics record. */
const INSPECT_PACKAGES = ['vitest', 'typescript'];

const ALL_TOOLS = { read_file: readFile, list_dir: listDir, grep, write_file: writeFile, run_command: runCommand } as const;
const SETUP_TIMEOUT_MS = 600_000;
const TEMPLATE_READY_MARKER = '.crucible-template-ready';

export interface HarnessDeps {
  spec: BenchmarkSpec;
  /** Directory containing benchmark.json; fixture.path is relative to it. */
  benchmarkDir: string;
  provider: Provider;
  promptPath: string;
  scratchDir: string;
  resultsDir: string;
  clock: Clock;
  ids: IdGen;
  environment: { node: string; pnpm: string | null; runtimeVersion: string };
  /** Wired by the host to the provider's onRetry; read+reset per run. */
  retryTally?: { value: number } | undefined;
  log?: ((line: string) => void) | undefined;
  overrides?: { model?: string | undefined; runs?: number | undefined } | undefined;
}

export async function runBenchmark(deps: HarnessDeps): Promise<BenchmarkReport> {
  const { spec, clock, ids } = deps;
  const log = deps.log ?? ((): void => undefined);
  const model = deps.overrides?.model ?? spec.model.pin;
  const seeds = spec.runs.seeds.slice(0, deps.overrides?.runs ?? spec.runs.count);

  const fixtureDir = path.resolve(deps.benchmarkDir, spec.fixture.path);
  const fixtureHash = hashTree(fixtureDir);
  const prompt = loadPrompt(deps.promptPath);
  const startedAtMs = clock.now();

  const templateDir = await prepareTemplate({ spec, fixtureDir, fixtureHash, deps, log });

  const capabilities = deps.provider.capabilities(model);
  const sampling = spec.model.sampling ?? capabilities.sampling ?? {};

  const runs: RunResult[] = [];
  for (const [index, seed] of seeds.entries()) {
    const runId = ids.next('run');
    log(`run ${index + 1}/${seeds.length} (seed ${seed}, ${runId}) …`);
    const result = await executeRun({ deps, model, sampling, seed, runId, templateDir, prompt: prompt.body });
    runs.push(result);
    log(
      result.passed
        ? `  PASS — ${result.metrics.iterations} iterations, ${result.metrics.tool_calls.total} tool calls, ${result.metrics.tokens.total} tokens`
        : `  FAIL (${result.failure_reason ?? 'unknown'}) — ${result.failures[0] ?? ''}`,
    );
    if (deps.retryTally) deps.retryTally.value = 0;
  }

  const passes = runs.filter((r) => r.passed).length;
  const report: BenchmarkReport = {
    reportVersion: REPORT_VERSION,
    benchmarkId: spec.id,
    passed: passes >= spec.scoring.requiredPasses,
    startedAtMs,
    finishedAtMs: clock.now(),
    environment: {
      providerId: deps.provider.id,
      model,
      modelDigest: (await deps.provider.modelDigest?.(model)) ?? null,
      promptVersion: prompt.version,
      fixtureHash,
      seeds,
      node: deps.environment.node,
      pnpm: deps.environment.pnpm,
      runtimeVersion: deps.environment.runtimeVersion,
    },
    runs,
    aggregates: {
      pass_rate: runs.length === 0 ? 0 : passes / runs.length,
      passes,
      total_runs: runs.length,
      tokens_total: aggregate(runs.map((r) => r.metrics.tokens.total)),
      wall_clock_ms: aggregate(runs.map((r) => r.metrics.wall_clock_ms)),
      iterations: aggregate(runs.map((r) => r.metrics.iterations)),
      tool_calls_total: aggregate(runs.map((r) => r.metrics.tool_calls.total)),
      invalid_tool_calls_total: aggregate(runs.map((r) => r.metrics.invalid_tool_calls.total)),
    },
  };

  fs.mkdirSync(deps.resultsDir, { recursive: true });
  const stamp = new Date(report.finishedAtMs).toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(deps.resultsDir, `${spec.id}-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  log(`report: ${reportPath} — ${passes}/${runs.length} passed (${report.passed ? 'BENCHMARK PASS' : 'BENCHMARK FAIL'})`);
  return report;
}

// The template's role: fail fast on a broken setupCommand (once, not per run)
// and warm the pnpm store so the per-workspace installs below are sub-second
// and offline. Its installed node_modules is deliberately NEVER copied.
async function prepareTemplate(args: {
  spec: BenchmarkSpec;
  fixtureDir: string;
  fixtureHash: string;
  deps: HarnessDeps;
  log: (line: string) => void;
}): Promise<string> {
  const templateDir = path.join(
    args.deps.scratchDir,
    'templates',
    `${args.spec.id}-${args.fixtureHash.slice(0, 12)}`,
  );
  const marker = path.join(templateDir, TEMPLATE_READY_MARKER);
  if (fs.existsSync(marker)) return templateDir;

  args.log(`preparing fixture template (${templateDir}) …`);
  fs.rmSync(templateDir, { recursive: true, force: true });
  fs.mkdirSync(templateDir, { recursive: true });
  fs.cpSync(args.fixtureDir, templateDir, { recursive: true, verbatimSymlinks: true });
  if (args.spec.fixture.setupCommand !== undefined) {
    const outcome = await runGateCommand(args.spec.fixture.setupCommand, templateDir, SETUP_TIMEOUT_MS);
    if (outcome.exitCode !== 0) {
      throw new Error(
        `fixture setup failed (exit ${outcome.exitCode}): ${args.spec.fixture.setupCommand}\n${outcome.outputTail}`,
      );
    }
  }
  fs.writeFileSync(marker, args.fixtureHash);
  return templateDir;
}

async function executeRun(args: {
  deps: HarnessDeps;
  model: string;
  sampling: { temperature?: number | undefined; topP?: number | undefined; topK?: number | undefined };
  seed: number;
  runId: string;
  templateDir: string;
  prompt: string;
}): Promise<RunResult> {
  const { deps, seed, runId } = args;
  const { spec, clock } = deps;

  const runDir = path.join(deps.scratchDir, 'bench', spec.id, runId);
  const workspace = path.join(runDir, 'workspace');
  fs.mkdirSync(runDir, { recursive: true });
  // Copy SOURCES only — never an installed node_modules. pnpm's package links
  // (relative symlinks on POSIX, junctions with absolute targets on Windows)
  // do not survive fs.cpSync portably: Windows dereferences junctions, which
  // materializes packages WITHOUT their .pnpm sibling graph and breaks module
  // resolution (verified: ERR_MODULE_NOT_FOUND '@vitest/utils'). Each
  // workspace installs fresh instead — fast, because the template's install
  // already warmed the pnpm store.
  fs.cpSync(args.templateDir, workspace, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => path.basename(src) !== 'node_modules',
  });
  fs.rmSync(path.join(workspace, TEMPLATE_READY_MARKER), { force: true });
  if (spec.fixture.setupCommand !== undefined) {
    const setup = await runGateCommand(spec.fixture.setupCommand, workspace, SETUP_TIMEOUT_MS);
    if (setup.exitCode !== 0) {
      throw new Error(
        `workspace setup failed (exit ${setup.exitCode}): ${spec.fixture.setupCommand}\n${headTail(setup.output)}`,
      );
    }
  }

  const protectedGlobs = spec.verifiers.flatMap((v) => (v.kind === 'files_unchanged' ? v.paths : []));
  const protectedBaseline = protectedGlobs.length > 0 ? hashFiles(workspace, protectedGlobs) : {};

  const registry = new ToolRegistry();
  for (const name of spec.tools.allowed) {
    const tool = ALL_TOOLS[name as keyof typeof ALL_TOOLS];
    if (tool === undefined) throw new Error(`benchmark spec allows unknown tool: ${name}`);
    // The union collapses each tool's precise In type; the registry re-validates
    // every call against the tool's own Zod schema, so the cast is safe.
    registry.register(tool as unknown as Tool);
  }

  const journalPath = path.join(runDir, 'journal.jsonl');
  const transcript = createTranscriptWriter(journalPath, {
    benchmarkId: spec.id,
    specVersion: spec.specVersion,
    runId,
    model: args.model,
    seed,
    sampling: args.sampling,
    budgets: spec.budgets,
    tools: spec.tools,
  });

  const session = AgentSession.create({
    role: 'architect',
    systemPrompt: interpolate(args.prompt, {}),
    provider: deps.provider,
    model: args.model,
    contextWindow: deps.provider.capabilities(args.model).contextWindow,
    chatOptions: { ...args.sampling, seed },
    tools: registry,
    workspace,
    surface: spec.tools.writableSurface,
    budgets: spec.budgets,
    clock,
    ids: deps.ids,
    sink: transcript.sink,
  });

  const runStarted = clock.now();
  let turn: TurnResult;
  try {
    turn = await session.runTurn(interpolate(spec.task.briefTemplate, {}));
  } finally {
    transcript.close();
  }
  const wallClockMs = clock.now() - runStarted;

  const events = readJournal(journalPath).events;
  const metrics = computeMetrics(events, turn, wallClockMs, deps.retryTally?.value ?? 0);

  const verification = await runVerifiers({
    verifiers: spec.verifiers,
    workspace,
    protectedBaseline,
    events,
  });
  const replay = validateReplay(journalPath, session.state());

  const failures = verification.failures.map((f) => `${f.verifier}: ${f.detail}`);
  if (!replay.ok) failures.unshift(`replay_validation: ${replay.detail}`);

  // Precedence (V0.1_SPEC.md §8.3): a replay mismatch fails the run even when
  // the tests went green — an incomplete audit log is a runtime bug.
  let failureReason: FailureReason | undefined;
  if (!replay.ok) failureReason = 'replay_mismatch';
  else if (turn.outcome === 'context_overflow') failureReason = 'context_overflow';
  else if (turn.outcome === 'max_iterations') failureReason = 'max_iterations';
  else if (turn.outcome === 'budget_exceeded') failureReason = 'wall_clock_exceeded';
  else if (turn.outcome === 'provider_failed') failureReason = 'provider_failed';
  else if (turn.outcome === 'aborted') failureReason = 'aborted';
  else if (verification.protectedModified) failureReason = 'protected_file_modified';
  else if (verification.failures.length > 0) failureReason = 'verification_failed';

  const result: RunResult = {
    runId,
    seed,
    passed: failureReason === undefined,
    ...(failureReason !== undefined ? { failure_reason: failureReason } : {}),
    failures,
    metrics,
    journalPath,
  };

  // Diagnostic record: EVERY input to the `passed` decision, written beside
  // the journal whether the run passed or failed — the artifact to diff when
  // the same run scores differently on two platforms.
  fs.writeFileSync(
    path.join(runDir, 'diagnostics.json'),
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        workspace,
        // Staging forensics: is the workspace's dependency tree real, and do
        // its links still resolve after the template -> workspace copy?
        workspace_inspection: inspectInstalledTree(workspace, INSPECT_PACKAGES),
        template_inspection: inspectInstalledTree(args.templateDir, INSPECT_PACKAGES),
        turn_outcome: turn.outcome,
        turn_final_text: turn.finalText.slice(0, 500),
        replay_validation: replay,
        verifier_outcomes: verification.outcomes,
        protected_modified: verification.protectedModified,
        protected_baseline_files: Object.keys(protectedBaseline).sort(),
        failure_reason: failureReason ?? null,
        result,
      },
      null,
      2,
    ) + '\n',
  );
  return result;
}

function computeMetrics(
  events: RuntimeEvent[],
  turn: TurnResult,
  wallClockMs: number,
  providerRetries: number,
): RunMetrics {
  const byTool: Record<string, number> = {};
  let toolCalls = 0;
  const invalid = { validation_failed: 0, unknown_tool: 0, policy_denied: 0 };
  for (const event of events) {
    if (event.type === 'tool_call') {
      toolCalls += 1;
      byTool[event.call.name] = (byTool[event.call.name] ?? 0) + 1;
    }
    if (event.type === 'tool_result' && !event.ok && event.errorKind !== undefined) {
      if (event.errorKind === 'validation_failed') invalid.validation_failed += 1;
      else if (event.errorKind === 'unknown_tool') invalid.unknown_tool += 1;
      else if (event.errorKind === 'policy_denied') invalid.policy_denied += 1;
    }
  }
  return {
    tool_calls: { total: toolCalls, by_tool: byTool },
    invalid_tool_calls: {
      total: invalid.validation_failed + invalid.unknown_tool + invalid.policy_denied,
      ...invalid,
    },
    provider_retries: providerRetries,
    tokens: {
      input: turn.usage.inputTokens,
      output: turn.usage.outputTokens,
      total: turn.usage.inputTokens + turn.usage.outputTokens,
    },
    wall_clock_ms: wallClockMs,
    iterations: turn.iterations,
  };
}
