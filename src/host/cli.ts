// `crucible bench <name>` — the v0.1 exit gate.
// `crucible chat`         — a plain debug REPL over one session (dev tool).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { realClock, realIdGen, realRng } from './env.js';
import { createTranscriptWriter } from './transcript.js';
import { OllamaProvider } from '../providers/ollama/provider.js';
import { AgentSession } from '../core/session.js';
import { standardRegistry } from '../tools/builtin/index.js';
import { runBenchmark } from '../bench/harness.js';
import { benchmarkSpecSchema } from '../bench/spec.js';
import { loadPrompt } from '../bench/prompt.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[arg.slice(2)] = 'true';
      } else {
        flags[arg.slice(2)] = value;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function detectPnpmVersion(): string | null {
  try {
    return execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function runtimeVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

async function bench(argv: string[]): Promise<number> {
  const { positional, flags } = parseFlags(argv);
  const name = positional[0];
  if (name === undefined) {
    console.error('usage: crucible bench <benchmark-name> [--model <tag>] [--runs <n>]');
    return 2;
  }
  const benchmarkDir = path.join(REPO_ROOT, 'benchmarks', name);
  const specPath = path.join(benchmarkDir, 'benchmark.json');
  if (!fs.existsSync(specPath)) {
    console.error(`no such benchmark: ${name} (${specPath} not found)`);
    return 2;
  }
  const spec = benchmarkSpecSchema.parse(JSON.parse(fs.readFileSync(specPath, 'utf8')));

  const config = loadConfig();
  const clock = realClock();
  const ids = realIdGen();
  const retryTally = { value: 0 };
  const provider = new OllamaProvider({
    baseUrl: config.ollamaBaseUrl,
    clock,
    ids,
    rng: realRng(),
    onRetry: (attempt, delayMs, reason) => {
      retryTally.value += 1;
      console.error(`  provider retry #${attempt} in ${delayMs}ms: ${reason}`);
    },
  });

  const report = await runBenchmark({
    spec,
    benchmarkDir,
    provider,
    promptPath: path.join(REPO_ROOT, 'prompts', 'architect', 'system.md'),
    scratchDir: config.scratchDir,
    resultsDir: path.join(REPO_ROOT, 'benchmarks', 'results'),
    clock,
    ids,
    environment: { node: process.version, pnpm: detectPnpmVersion(), runtimeVersion: runtimeVersion() },
    retryTally,
    log: (line) => console.log(line),
    overrides: {
      model: flags['model'],
      runs: flags['runs'] !== undefined ? Number(flags['runs']) : undefined,
    },
  });
  return report.passed ? 0 : 1;
}

async function chat(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const config = loadConfig();
  const clock = realClock();
  const ids = realIdGen();
  const model = flags['model'] ?? 'qwen3:14b';
  const workspace = path.resolve(flags['workspace'] ?? process.cwd());

  const provider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, clock, ids, rng: realRng() });
  const prompt = loadPrompt(path.join(REPO_ROOT, 'prompts', 'architect', 'system.md'));
  const transcript = createTranscriptWriter(
    path.join(config.scratchDir, 'chat', `${ids.next('chat')}.jsonl`),
    { mode: 'chat', model, workspace },
  );
  const session = AgentSession.create({
    role: 'architect',
    systemPrompt: prompt.body,
    provider,
    model,
    chatOptions: provider.capabilities(model).sampling ?? {},
    tools: standardRegistry(),
    workspace,
    budgets: { maxIterations: 24, wallClockMs: 600_000 },
    clock,
    ids,
    sink: (event) => {
      transcript.sink(event);
      if (event.type === 'tool_call') {
        console.log(`  ⚙ ${event.call.name} ${JSON.stringify(event.call.arguments).slice(0, 120)}`);
      }
    },
  });

  console.log(`crucible chat — ${model} on ${workspace} (transcript: ${transcript.filePath})`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): void => {
    rl.question('> ', (line) => {
      if (line.trim() === '/quit' || line.trim() === '') {
        transcript.close();
        rl.close();
        return;
      }
      void session.runTurn(line).then((result) => {
        console.log(`\n${result.finalText}\n[${result.outcome}: ${result.iterations} iterations, ${result.usage.inputTokens}+${result.usage.outputTokens} tokens]`);
        ask();
      });
    });
  };
  ask();
  return 0;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let code: number;
  switch (command) {
    case 'bench':
      code = await bench(rest);
      break;
    case 'chat':
      code = await chat(rest);
      return; // REPL manages its own lifecycle
    default:
      console.error('usage: crucible <bench|chat> …');
      code = 2;
  }
  process.exitCode = code;
}

void main();
