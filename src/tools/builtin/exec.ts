import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from '../types.js';
import { ok } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const TAIL_CHARS = 4_000;

export interface RunCommandOutput {
  exitCode: number;
  timedOut: boolean;
}

const runCommandInput = z.object({
  command: z.string().min(1).describe('Shell command to run in the workspace root.'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Hard timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
});

/** Keep the end of a stream — that's where errors and summaries live. */
function tail(s: string): string {
  return s.length <= TAIL_CHARS ? s : `… (${s.length - TAIL_CHARS} chars omitted)\n${s.slice(-TAIL_CHARS)}`;
}

export const runCommand: Tool<z.infer<typeof runCommandInput>, RunCommandOutput> = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace root and return its REAL exit code plus output. Use this to run the tests. A non-zero exit code means failure; exit 124 means the command hung and was killed.',
  inputSchema: runCommandInput,
  safety: 'mutating',
  parallelSafe: false,
  // Executor cap sits above the largest command timeout so the command-level
  // kill (which reports exit 124 to the model) always fires first.
  timeoutMs: MAX_TIMEOUT_MS + 10_000,
  async execute(input, ctx) {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const child = spawn(input.command, {
        cwd: ctx.workspace,
        shell: true,
        env: { ...process.env, CI: 'true' }, // never let a runner drop into watch mode
        detached: true, // own process group, so a kill takes the whole tree
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

      // Kill the process GROUP: killing only the shell leaves grandchildren
      // holding the stdio pipes open, and 'close' never fires (the zombie-gate
      // lesson, PIPELINE.md §4).
      const killTree = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const killTimer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
      const onAbort = (): void => {
        killTree();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        const exitCode = timedOut ? 124 : (code ?? 1);
        const verdict = timedOut
          ? `exit code: 124 (TIMED OUT after ${timeoutMs}ms — the command HUNG; this is a failure to investigate, NOT a pass)`
          : `exit code: ${exitCode}`;
        resolve(
          ok(
            { exitCode, timedOut },
            `$ ${input.command}\n${verdict}\n--- stdout (tail) ---\n${tail(stdout)}\n--- stderr (tail) ---\n${tail(stderr)}`,
          ),
        );
      });
      child.on('error', (err) => {
        clearTimeout(killTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(
          ok(
            { exitCode: 127, timedOut: false },
            `$ ${input.command}\nexit code: 127 (failed to start: ${err.message})`,
          ),
        );
      });
    });
  },
};
