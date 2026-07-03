import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { Tool } from '../types.js';
import { ok, fail } from '../types.js';
import { matchesSurface, resolveInWorkspace } from '../paths.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.crucible-scratch']);
const READ_CHAR_BUDGET = 40_000;
const LIST_ENTRY_CAP = 500;

const readFileInput = z.object({
  path: z.string().describe('File path relative to the workspace root.'),
  offset: z.number().int().min(1).optional().describe('1-based first line to read.'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to return.'),
});

export const readFile: Tool<z.infer<typeof readFileInput>, { path: string; totalLines: number }> = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns line-numbered content. Use offset/limit for large files.',
  inputSchema: readFileInput,
  safety: 'safe',
  parallelSafe: true,
  timeoutMs: 10_000,
  async execute(input, ctx) {
    const resolved = resolveInWorkspace(ctx.workspace, input.path);
    if (!resolved.ok) return fail({ kind: 'policy_denied', message: resolved.reason });
    if (!fs.existsSync(resolved.abs) || !fs.statSync(resolved.abs).isFile()) {
      return fail({ kind: 'execution_failed', message: `no such file: ${input.path}` });
    }

    const lines = fs.readFileSync(resolved.abs, 'utf8').split('\n');
    const totalLines = lines.length;
    const start = (input.offset ?? 1) - 1;
    const selected = lines.slice(start, input.limit === undefined ? undefined : start + input.limit);

    const numbered = selected.map((line, i) => `${String(start + i + 1).padStart(5)}\t${line}`);
    let forModel = numbered.join('\n');
    if (forModel.length > READ_CHAR_BUDGET) {
      // Degrade head+tail (V0.1_SPEC.md §6): errors and signatures live at the edges.
      const head = numbered.slice(0, 120).join('\n');
      const tail = numbered.slice(-40).join('\n');
      const omitted = numbered.length - 160;
      forModel = `${head}\n… ${omitted} lines omitted (re-read with offset/limit for the middle) …\n${tail}`;
    }
    return ok({ path: resolved.rel, totalLines }, `${resolved.rel} (${totalLines} lines):\n${forModel}`);
  },
};

const listDirInput = z.object({
  path: z.string().optional().describe('Directory relative to the workspace root; defaults to the root.'),
});

export const listDir: Tool<z.infer<typeof listDirInput>, { entries: number }> = {
  name: 'list_dir',
  description:
    'Recursively list files and directories in the workspace (node_modules and .git are skipped). Shows file sizes.',
  inputSchema: listDirInput,
  safety: 'safe',
  parallelSafe: true,
  timeoutMs: 10_000,
  async execute(input, ctx) {
    const resolved = resolveInWorkspace(ctx.workspace, input.path ?? '.');
    if (!resolved.ok) return fail({ kind: 'policy_denied', message: resolved.reason });
    if (!fs.existsSync(resolved.abs) || !fs.statSync(resolved.abs).isDirectory()) {
      return fail({ kind: 'execution_failed', message: `no such directory: ${input.path ?? '.'}` });
    }

    const out: string[] = [];
    let truncated = false;
    const walk = (dir: string, prefix: string): void => {
      if (truncated) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= LIST_ENTRY_CAP) {
          truncated = true;
          return;
        }
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          out.push(`${rel}/`);
          walk(path.join(dir, entry.name), rel);
        } else {
          out.push(`${rel} (${fs.statSync(path.join(dir, entry.name)).size} bytes)`);
        }
      }
    };
    walk(resolved.abs, resolved.rel === '.' ? '' : resolved.rel);
    const listing = out.join('\n') + (truncated ? `\n… truncated at ${LIST_ENTRY_CAP} entries` : '');
    return ok({ entries: out.length }, listing.length > 0 ? listing : '(empty directory)');
  },
};

const writeFileInput = z.object({
  path: z.string().describe('File path relative to the workspace root.'),
  content: z.string().describe('The complete new file content (full overwrite).'),
});

export const writeFile: Tool<z.infer<typeof writeFileInput>, { path: string; bytes: number }> = {
  name: 'write_file',
  description:
    'Write the COMPLETE content of a file (full overwrite). Include the entire file, not a fragment. Only paths inside the allowed write surface are permitted.',
  inputSchema: writeFileInput,
  safety: 'mutating',
  parallelSafe: false,
  timeoutMs: 10_000,
  async execute(input, ctx) {
    const resolved = resolveInWorkspace(ctx.workspace, input.path);
    if (!resolved.ok) {
      ctx.emitter.emit({
        type: 'policy_denied',
        tool: 'write_file',
        path: input.path,
        reason: resolved.reason,
      });
      return fail({ kind: 'policy_denied', message: resolved.reason });
    }
    if (ctx.surface !== undefined && !matchesSurface(resolved.rel, ctx.surface)) {
      const reason = `write denied: ${resolved.rel} is outside the allowed surface [${ctx.surface.join(', ')}]`;
      ctx.emitter.emit({
        type: 'policy_denied',
        tool: 'write_file',
        path: resolved.rel,
        reason,
      });
      return fail(
        { kind: 'policy_denied', message: reason },
        `DENIED: ${reason}. Fix the implementation within the allowed surface instead.`,
      );
    }
    fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
    fs.writeFileSync(resolved.abs, input.content, 'utf8');
    const bytes = Buffer.byteLength(input.content, 'utf8');
    return ok({ path: resolved.rel, bytes }, `Wrote ${bytes} bytes to ${resolved.rel}.`);
  },
};
