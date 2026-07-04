import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import picomatch from 'picomatch';
import type { Tool } from '../types.js';
import { ok, fail } from '../types.js';
import { resolveInWorkspace } from '../paths.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.crucible-scratch']);
const MATCH_CAP = 200;
const LINE_SNIPPET = 400;
const GLOB_CAP = 500;

const grepInput = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Regular expression (JavaScript syntax); falls back to a literal search if invalid.'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search, relative to the workspace root; defaults to the whole workspace.'),
});

export const grep: Tool<z.infer<typeof grepInput>, { matches: number }> = {
  name: 'grep',
  description:
    'Search file contents for a pattern. Returns matching lines as "path:line: text".',
  inputSchema: grepInput,
  safety: 'safe',
  parallelSafe: true,
  timeoutMs: 30_000,
  async execute(input, ctx) {
    const resolved = resolveInWorkspace(ctx.workspace, input.path ?? '.');
    if (!resolved.ok) return fail({ kind: 'policy_denied', message: resolved.reason });
    if (!fs.existsSync(resolved.abs)) {
      return fail({ kind: 'execution_failed', message: `no such path: ${input.path ?? '.'}` });
    }

    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch {
      regex = new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }

    const matches: string[] = [];
    const searchFile = (abs: string, rel: string): void => {
      if (matches.length >= MATCH_CAP) return;
      let text: string;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        return; // unreadable/binary — skip
      }
      if (text.includes('\u0000')) return; // binary
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < MATCH_CAP; i++) {
        const line = lines[i] ?? '';
        if (regex.test(line)) {
          matches.push(`${rel}:${i + 1}: ${line.slice(0, LINE_SNIPPET)}`);
        }
      }
    };
    const walk = (dir: string, prefix: string): void => {
      // H2 cooperative abort at directory boundaries; MATCH_CAP is the backstop.
      if (matches.length >= MATCH_CAP || ctx.signal.aborted) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile()) {
          searchFile(path.join(dir, entry.name), rel);
        }
      }
    };

    if (fs.statSync(resolved.abs).isDirectory()) {
      walk(resolved.abs, resolved.rel === '.' ? '' : resolved.rel);
    } else {
      searchFile(resolved.abs, resolved.rel);
    }

    if (matches.length === 0) return ok({ matches: 0 }, `No matches for ${JSON.stringify(input.pattern)}.`);
    const capped = matches.length >= MATCH_CAP ? `\n… capped at ${MATCH_CAP} matches` : '';
    return ok({ matches: matches.length }, matches.join('\n') + capped);
  },
};

const globInput = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Glob pattern relative to the workspace root, e.g. "src/**/*.ts" or "**/*.json".'),
});

export const glob: Tool<z.infer<typeof globInput>, { matches: number }> = {
  name: 'glob',
  description:
    'Find files whose workspace-relative path matches a glob pattern. Returns matching paths, sorted.',
  inputSchema: globInput,
  safety: 'safe',
  parallelSafe: true,
  timeoutMs: 10_000,
  async execute(input, ctx) {
    const isMatch = picomatch(input.pattern, { dot: true });
    const found: string[] = [];
    let truncated = false;
    const walk = (dir: string, prefix: string): void => {
      if (truncated || ctx.signal.aborted) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile() && isMatch(rel)) {
          if (found.length >= GLOB_CAP) {
            truncated = true;
            return;
          }
          found.push(rel);
        }
      }
    };
    walk(ctx.workspace, '');
    if (found.length === 0) return ok({ matches: 0 }, `No files match ${JSON.stringify(input.pattern)}.`);
    const capped = truncated ? `\n… capped at ${GLOB_CAP} matches` : '';
    return ok({ matches: found.length }, found.join('\n') + capped);
  },
};
