// Independent post-run verification (V0.1_SPEC.md §5.6): the harness runs the
// spec's verifiers itself with real exit codes — the agent's claim is never
// the signal. Plus the replay validation of §8.3.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { RuntimeEvent } from '../core/events.js';
import type { SessionState } from '../core/session.js';
import { readJournal, reconstructSession, stableStringify } from '../host/transcript.js';
import type { Verifier } from './spec.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

export function hashFiles(root: string, globs: string[]): Record<string, string> {
  const isMatch = picomatch(globs, { dot: true });
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (isMatch(rel)) {
          out[rel] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        }
      }
    }
  };
  walk(root);
  return out;
}

/** Hash a whole directory tree (the fixture identity for the report). */
export function hashTree(root: string): string {
  const hash = createHash('sha256');
  const files = hashFiles(root, ['**/*']);
  for (const rel of Object.keys(files).sort()) hash.update(`${rel}\0${files[rel]}\0`);
  return hash.digest('hex');
}

const OUTPUT_CAP = 65_536;

export interface CommandOutcome {
  exitCode: number;
  timedOut: boolean;
  /** Full combined stdout+stderr, capped at 64 KiB (middle elided). */
  output: string;
  outputTail: string;
}

/**
 * Head + tail rendering: error names (e.g. "Cannot find module 'x'") lead the
 * output; summaries end it. A tail-only slice loses the former.
 */
export function headTail(s: string, chars = 1_500): string {
  if (s.length <= chars * 2) return s;
  return `${s.slice(0, chars)}\n… ${s.length - chars * 2} chars elided …\n${s.slice(-chars)}`;
}

/** Run a verifier command with a REAL exit code under a hard timeout. */
export function runGateCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: 'true' } });
    let output = '';
    let timedOut = false;
    const collect = (d: Buffer): void => {
      if (output.length < OUTPUT_CAP) output += d.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
        output,
        outputTail: output.slice(-2_000),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, timedOut: false, output: String(err), outputTail: String(err) });
    });
  });
}

export interface VerifierFailure {
  verifier: string;
  detail: string;
}

/** Every verifier's outcome, recorded whether it passed or failed — the
 * diagnostic record for cross-platform "why did passed flip" comparisons. */
export interface VerifierOutcome {
  verifier: string;
  ok: boolean;
  detail: string;
}

export async function runVerifiers(args: {
  verifiers: Verifier[];
  workspace: string;
  protectedBaseline: Record<string, string>;
  events: RuntimeEvent[];
}): Promise<{
  failures: VerifierFailure[];
  protectedModified: boolean;
  outcomes: VerifierOutcome[];
}> {
  const outcomes: VerifierOutcome[] = [];
  let protectedModified = false;

  for (const verifier of args.verifiers) {
    switch (verifier.kind) {
      case 'command_exit_zero': {
        const outcome = await runGateCommand(verifier.command, args.workspace, verifier.timeoutMs);
        outcomes.push({
          verifier: `command_exit_zero(${verifier.command})`,
          ok: outcome.exitCode === 0,
          detail: outcome.timedOut
            ? `HUNG — killed after ${verifier.timeoutMs}ms (exit 124); output: ${headTail(outcome.output)}`
            : `exit ${outcome.exitCode}; output: ${headTail(outcome.output)}`,
        });
        break;
      }
      case 'files_unchanged': {
        const after = hashFiles(args.workspace, verifier.paths);
        const before = args.protectedBaseline;
        const changed = [
          ...Object.keys(before).filter((rel) => after[rel] !== before[rel]),
          ...Object.keys(after).filter((rel) => before[rel] === undefined),
        ];
        if (changed.length > 0) protectedModified = true;
        outcomes.push({
          verifier: 'files_unchanged',
          ok: changed.length === 0,
          detail:
            changed.length === 0
              ? `${Object.keys(before).length} protected files unchanged (baseline ${Object.keys(before).length}, after ${Object.keys(after).length})`
              : `protected files modified: ${changed.join(', ')} (baseline ${Object.keys(before).length}, after ${Object.keys(after).length})`,
        });
        break;
      }
      case 'file_exists': {
        const exists = fs.existsSync(path.join(args.workspace, verifier.path));
        outcomes.push({
          verifier: 'file_exists',
          ok: exists,
          detail: exists ? `present: ${verifier.path}` : `missing: ${verifier.path}`,
        });
        break;
      }
      case 'transcript_assert': {
        const ok = assertTranscript(verifier.assert, args.events);
        outcomes.push({
          verifier: `transcript_assert(${verifier.assert})`,
          ok,
          detail: ok ? 'assertion held' : 'assertion failed',
        });
        break;
      }
    }
  }
  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ verifier: o.verifier, detail: o.detail }));
  return { failures, protectedModified, outcomes };
}

function assertTranscript(
  assert: 'failure_observed_before_first_write',
  events: RuntimeEvent[],
): boolean {
  // The agent must have SEEN a failing command (exit != 0) before its first
  // write — it observed the bug, it didn't fix blind.
  let failureObserved = false;
  for (const event of events) {
    if (event.type === 'tool_result' && event.message.name === 'run_command' && event.ok) {
      const output = event.output as { exitCode?: number } | undefined;
      if (typeof output?.exitCode === 'number' && output.exitCode !== 0) failureObserved = true;
    }
    if (event.type === 'tool_call' && event.call.name === 'write_file') {
      return failureObserved;
    }
  }
  // No write at all ⇒ the bug can't have been fixed; let the command verifier
  // report that — this assert is specifically about ordering.
  return true;
}

export interface InstalledPackageInfo {
  kind: 'missing' | 'directory' | 'link' | 'file';
  /** For links (symlink or Windows junction): the raw target as stored. */
  target?: string;
  targetExists?: boolean;
}

export interface InstalledTreeInspection {
  root: string;
  node_modules_exists: boolean;
  bin_dir_exists: boolean;
  bin_entries: string[];
  packages: Record<string, InstalledPackageInfo>;
}

/**
 * Diagnostic snapshot of an installed dependency tree: does node_modules
 * exist, is the .bin populated, and are package entries real directories or
 * links (pnpm uses relative symlinks on POSIX and junctions with ABSOLUTE
 * targets on Windows — copy semantics differ, so record kind + target).
 */
export function inspectInstalledTree(root: string, packages: string[]): InstalledTreeInspection {
  const nm = path.join(root, 'node_modules');
  const bin = path.join(nm, '.bin');
  const inspection: InstalledTreeInspection = {
    root,
    node_modules_exists: fs.existsSync(nm),
    bin_dir_exists: fs.existsSync(bin),
    bin_entries: [],
    packages: {},
  };
  try {
    inspection.bin_entries = fs.readdirSync(bin).sort().slice(0, 12);
  } catch {
    /* bin missing — already recorded */
  }
  for (const name of packages) {
    const p = path.join(nm, name);
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) {
        let target: string | undefined;
        let targetExists: boolean | undefined;
        try {
          target = fs.readlinkSync(p);
          targetExists = fs.existsSync(path.resolve(path.dirname(p), target));
        } catch {
          /* unreadable link */
        }
        inspection.packages[name] = { kind: 'link', ...(target !== undefined ? { target } : {}), ...(targetExists !== undefined ? { targetExists } : {}) };
      } else if (stat.isDirectory()) {
        inspection.packages[name] = { kind: 'directory' };
      } else {
        inspection.packages[name] = { kind: 'file' };
      }
    } catch {
      inspection.packages[name] = { kind: 'missing' };
    }
  }
  return inspection;
}

export interface ReplayOutcome {
  ok: boolean;
  detail: string;
}

/**
 * §8.3: rebuild the session from the journal alone and deep-compare against
 * the live final state. Any divergence is a runtime bug.
 */
export function validateReplay(journalPath: string, liveState: SessionState): ReplayOutcome {
  try {
    const reconstructed = reconstructSession(readJournal(journalPath));
    const a = stableStringify(reconstructed);
    const b = stableStringify(liveState);
    if (a !== b) {
      return { ok: false, detail: 'reconstructed session state differs from live state' };
    }
    return { ok: true, detail: '' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
