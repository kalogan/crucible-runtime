import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ok } from '../../src/tools/types.js';
import type { Tool, ToolContext } from '../../src/tools/types.js';
import { readFile, listDir, writeFile, grep, runCommand, standardRegistry } from '../../src/tools/builtin/index.js';
import { createEmitter } from '../../src/core/events.js';
import type { RuntimeEvent } from '../../src/core/events.js';
import { FakeClock, firingClock } from '../fakes/clock.js';

let workspace: string;
const events: RuntimeEvent[] = [];

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  const clock = new FakeClock();
  return {
    workspace,
    signal: new AbortController().signal,
    clock,
    emitter: createEmitter('ses_test', () => clock.now(), (e) => events.push(e)),
    session: { id: 'ses_test', role: 'test' },
    ...overrides,
  };
}

function call(name: string, args: unknown) {
  return { id: 'call_1', name, arguments: args };
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-tools-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const A = 1;\n// needle here\n');
  fs.writeFileSync(path.join(workspace, 'README.md'), '# readme\n');
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('workspace boundary', () => {
  it('denies ../ traversal', async () => {
    const registry = new ToolRegistry().register(readFile);
    const result = await registry.execute(call('read_file', { path: '../../etc/passwd' }), ctx());
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('policy_denied');
  });

  it('denies absolute paths outside the workspace', async () => {
    const registry = new ToolRegistry().register(readFile);
    const result = await registry.execute(call('read_file', { path: '/etc/passwd' }), ctx());
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('policy_denied');
  });
});

describe('write surface enforcement', () => {
  it('allows writes inside the surface', async () => {
    const registry = new ToolRegistry().register(writeFile);
    const result = await registry.execute(
      call('write_file', { path: 'src/b.ts', content: 'export {};\n' }),
      ctx({ surface: ['src/**'] }),
    );
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'src', 'b.ts'))).toBe(true);
  });

  it('hard-denies writes outside the surface and emits policy_denied', async () => {
    const before = events.filter((e) => e.type === 'policy_denied').length;
    const registry = new ToolRegistry().register(writeFile);
    const result = await registry.execute(
      call('write_file', { path: 'README.md', content: 'clobbered' }),
      ctx({ surface: ['src/**'] }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('policy_denied');
    expect(result.message.content).toContain('DENIED');
    expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe('# readme\n');
    expect(events.filter((e) => e.type === 'policy_denied').length).toBe(before + 1);
  });
});

describe('read_file / list_dir / grep', () => {
  it('reads with line numbers', async () => {
    const registry = new ToolRegistry().register(readFile);
    const result = await registry.execute(call('read_file', { path: 'src/a.ts' }), ctx());
    expect(result.ok).toBe(true);
    expect(result.message.content).toContain('1\texport const A = 1;');
  });

  it('lists recursively with sizes, skipping node_modules', async () => {
    fs.mkdirSync(path.join(workspace, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'x', 'y.js'), 'ignored');
    const registry = new ToolRegistry().register(listDir);
    const result = await registry.execute(call('list_dir', {}), ctx());
    expect(result.ok).toBe(true);
    expect(result.message.content).toContain('src/a.ts');
    expect(result.message.content).not.toContain('y.js');
  });

  it('greps with path:line matches', async () => {
    const registry = new ToolRegistry().register(grep);
    const result = await registry.execute(call('grep', { pattern: 'needle' }), ctx());
    expect(result.ok).toBe(true);
    expect(result.message.content).toContain('src/a.ts:2');
  });

  it('falls back to literal search on invalid regex', async () => {
    const registry = new ToolRegistry().register(grep);
    const result = await registry.execute(call('grep', { pattern: 'needle (' }), ctx());
    expect(result.ok).toBe(true); // no crash; literal search finds nothing
  });
});

describe('run_command', () => {
  it('returns the real exit code and output tails', async () => {
    const registry = new ToolRegistry().register(runCommand);
    const result = await registry.execute(
      call('run_command', { command: 'echo out-marker && echo err-marker >&2 && exit 3' }),
      ctx(),
    );
    expect(result.ok).toBe(true); // the TOOL ran fine; the exit code is data
    expect(result.output).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.message.content).toContain('exit code: 3');
    expect(result.message.content).toContain('out-marker');
    expect(result.message.content).toContain('err-marker');
  });

  it('kills a hung command and reports exit 124 as a hang, not a pass', async () => {
    const registry = new ToolRegistry().register(runCommand);
    const result = await registry.execute(
      call('run_command', { command: 'sleep 30', timeoutMs: 1_000 }),
      ctx(),
    );
    expect(result.output).toMatchObject({ exitCode: 124, timedOut: true });
    expect(result.message.content).toContain('NOT a pass');
  }, 15_000);
});

describe('executor', () => {
  it('times out a hanging tool via the executor cap', async () => {
    const hangingTool: Tool<Record<string, never>, never> = {
      name: 'hang',
      description: 'never returns',
      inputSchema: z.object({}),
      safety: 'safe',
      parallelSafe: true,
      timeoutMs: 50,
      execute: () => new Promise(() => undefined),
    };
    const registry = new ToolRegistry().register(hangingTool);
    const clock = firingClock();
    const result = await registry.execute(call('hang', {}), ctx({ clock }));
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('timeout');
  });

  it('maps a throwing tool to execution_failed', async () => {
    const throwing: Tool<Record<string, never>, never> = {
      name: 'boom',
      description: 'throws',
      inputSchema: z.object({}),
      safety: 'safe',
      parallelSafe: true,
      timeoutMs: 1_000,
      execute: () => {
        throw new Error('kaboom');
      },
    };
    const registry = new ToolRegistry().register(throwing);
    const result = await registry.execute(call('boom', {}), ctx());
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('execution_failed');
    expect(result.message.content).toContain('kaboom');
  });

  it('generates JSON Schemas from Zod with required fields', () => {
    const registry = standardRegistry();
    const schemas = registry.jsonSchemas();
    expect(schemas.map((s) => s.name)).toEqual([
      'read_file',
      'list_dir',
      'grep',
      'write_file',
      'run_command',
    ]);
    const write = schemas.find((s) => s.name === 'write_file')!;
    expect(write.parameters['type']).toBe('object');
    expect(write.parameters['required']).toEqual(['path', 'content']);
  });

  it('exposes structured output alongside the rendered message', async () => {
    const outTool: Tool<Record<string, never>, { n: number }> = {
      name: 'out',
      description: 'returns data',
      inputSchema: z.object({}),
      safety: 'safe',
      parallelSafe: true,
      timeoutMs: 1_000,
      execute: async () => ok({ n: 7 }, 'n is 7'),
    };
    const registry = new ToolRegistry().register(outTool);
    const result = await registry.execute(call('out', {}), ctx());
    expect(result.output).toEqual({ n: 7 });
    expect(result.message.content).toBe('n is 7');
  });
});
