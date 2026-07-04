import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ok } from '../../src/tools/types.js';
import type { Tool, ToolContext } from '../../src/tools/types.js';
import { editFile, glob } from '../../src/tools/builtin/index.js';
import { buildCommandEnv } from '../../src/tools/env.js';
import { createEmitter } from '../../src/core/events.js';
import type { RuntimeEvent } from '../../src/core/events.js';
import { FakeClock, firingClock } from '../fakes/clock.js';

let workspace: string;
const events: RuntimeEvent[] = [];

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  const clock = overrides?.clock ?? new FakeClock();
  return {
    workspace,
    signal: new AbortController().signal,
    clock,
    emitter: createEmitter('ses', () => clock.now(), (e) => events.push(e)),
    session: { id: 'ses', role: 'test' },
    ...overrides,
  };
}
const call = (name: string, args: unknown) => ({ id: 'c1', name, arguments: args });

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-v2-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'interval.ts'), 'export const x = 1;\nexport const y = 2;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'dup.ts'), 'a\na\n');
  fs.writeFileSync(path.join(workspace, 'test.spec.ts'), 'test\n');
});
afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

describe('edit_file', () => {
  it('replaces a unique string', async () => {
    const r = new ToolRegistry().register(editFile);
    const res = await r.execute(
      call('edit_file', { path: 'src/interval.ts', old_string: 'const x = 1', new_string: 'const x = 42' }),
      ctx({ surface: ['src/**'] }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ path: 'src/interval.ts', replacements: 1 });
    expect(fs.readFileSync(path.join(workspace, 'src/interval.ts'), 'utf8')).toContain('const x = 42');
  });

  it('is denied outside the write surface', async () => {
    const r = new ToolRegistry().register(editFile);
    const res = await r.execute(
      call('edit_file', { path: 'test.spec.ts', old_string: 'test', new_string: 'gutted' }),
      ctx({ surface: ['src/**'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe('policy_denied');
    expect(fs.readFileSync(path.join(workspace, 'test.spec.ts'), 'utf8')).toBe('test\n');
  });

  it('errors when old_string is not found', async () => {
    const r = new ToolRegistry().register(editFile);
    const res = await r.execute(
      call('edit_file', { path: 'src/interval.ts', old_string: 'nonexistent', new_string: 'x' }),
      ctx({ surface: ['src/**'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.message.content).toContain('not found');
  });

  it('errors when old_string is not unique (unless replace_all)', async () => {
    const r = new ToolRegistry().register(editFile);
    const denied = await r.execute(
      call('edit_file', { path: 'src/dup.ts', old_string: 'a', new_string: 'b' }),
      ctx({ surface: ['src/**'] }),
    );
    expect(denied.ok).toBe(false);
    expect(denied.message.content).toContain('2 times');

    const okRes = await r.execute(
      call('edit_file', { path: 'src/dup.ts', old_string: 'a', new_string: 'b', replace_all: true }),
      ctx({ surface: ['src/**'] }),
    );
    expect(okRes.ok).toBe(true);
    expect(okRes.output).toEqual({ path: 'src/dup.ts', replacements: 2 });
  });

  it('rejects a no-op edit (identical strings)', async () => {
    const r = new ToolRegistry().register(editFile);
    const res = await r.execute(
      call('edit_file', { path: 'src/interval.ts', old_string: 'y', new_string: 'y' }),
      ctx({ surface: ['src/**'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.message.content).toContain('identical');
  });
});

describe('glob', () => {
  it('matches files by pattern, sorted', async () => {
    const r = new ToolRegistry().register(glob);
    const res = await r.execute(call('glob', { pattern: 'src/**/*.ts' }), ctx());
    expect(res.ok).toBe(true);
    expect(res.message.content).toContain('src/interval.ts');
    expect(res.message.content).toContain('src/dup.ts');
    expect(res.message.content).not.toContain('test.spec.ts');
  });

  it('reports no matches cleanly', async () => {
    const r = new ToolRegistry().register(glob);
    const res = await r.execute(call('glob', { pattern: '**/*.rs' }), ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ matches: 0 });
  });

  it('bails immediately when the signal is already aborted (cooperative abort)', async () => {
    const r = new ToolRegistry().register(glob);
    const controller = new AbortController();
    controller.abort();
    const res = await r.execute(call('glob', { pattern: 'src/**/*.ts' }), ctx({ signal: controller.signal }));
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ matches: 0 }); // walk returned before collecting
  });
});

describe('buildCommandEnv (H3)', () => {
  it('keeps infra vars, drops secrets, forces CI', () => {
    const env = buildCommandEnv({
      PATH: '/usr/bin',
      HOME: '/home/kevin',
      ANTHROPIC_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp_secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      MY_APP_PASSWORD: 'hunter2',
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/kevin');
    expect(env['CI']).toBe('true');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['MY_APP_PASSWORD']).toBeUndefined();
  });

  it('matches allowlist case-insensitively (Windows Path/Temp)', () => {
    const env = buildCommandEnv({ Path: 'C:\\Windows', Temp: 'C:\\Temp', SECRET: 'x' });
    expect(env['Path']).toBe('C:\\Windows');
    expect(env['Temp']).toBe('C:\\Temp');
    expect(env['SECRET']).toBeUndefined();
  });
});

describe('safety taxonomy enforcement', () => {
  const confirmTool: Tool<Record<string, never>, { ran: boolean }> = {
    name: 'risky',
    description: 'needs approval',
    inputSchema: z.object({}),
    safety: 'confirm',
    parallelSafe: false,
    timeoutMs: 1_000,
    execute: async () => ok({ ran: true }, 'ran'),
  };

  it('denies a confirm-class tool when unattended', async () => {
    const r = new ToolRegistry().register(confirmTool);
    const res = await r.execute(call('risky', {}), ctx()); // attended defaults false
    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe('policy_denied');
    expect(res.message.content).toContain('attended session');
    expect(events.some((e) => e.type === 'policy_denied' && e.tool === 'risky')).toBe(true);
  });

  it('allows a confirm-class tool when attended', async () => {
    const r = new ToolRegistry().register(confirmTool);
    const res = await r.execute(call('risky', {}), ctx({ attended: true }));
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ ran: true });
  });
});

describe('composed cancellation (H1)', () => {
  // A waiter that records when its ctx.signal fires. resolveOnAbort=false keeps
  // it pending (models a tool that heeds cancellation but can't return
  // instantly, e.g. a sync hang) so the executor cap wins the race
  // deterministically; true models graceful early return.
  function abortWaiter(
    seen: { aborted: boolean },
    resolveOnAbort: boolean,
  ): Tool<Record<string, never>, unknown> {
    return {
      name: 'waiter',
      description: 'waits for abort',
      inputSchema: z.object({}),
      safety: 'safe',
      parallelSafe: true,
      timeoutMs: 50,
      execute: (_input, c) =>
        new Promise((resolve) => {
          const onAbort = (): void => {
            seen.aborted = true;
            if (resolveOnAbort) resolve(ok({}, 'aborted'));
          };
          if (c.signal.aborted) onAbort();
          else c.signal.addEventListener('abort', onAbort);
        }),
    };
  }

  it('timeout fires the composed signal AND caps the tool', async () => {
    const seen = { aborted: false };
    const r = new ToolRegistry().register(abortWaiter(seen, false));
    // firingClock: the executor's timeout sleep resolves, aborts the tool (which
    // heeds but stays pending), so the executor cap wins → 'timeout'.
    const res = await r.execute(call('waiter', {}), ctx({ clock: firingClock() }));
    expect(res.errorKind).toBe('timeout'); // no tool outlives its slot
    expect(seen.aborted).toBe(true); // the tool WAS signaled, not just abandoned
  });

  it('session abort reaches the tool through the composed signal', async () => {
    const seen = { aborted: false };
    const r = new ToolRegistry().register(abortWaiter(seen, true));
    const controller = new AbortController();
    // FakeClock hangs its sleeps, so the timeout never fires; only the session
    // abort can end this — proving session-abort composes into ctx.signal.
    const p = r.execute(call('waiter', {}), ctx({ signal: controller.signal, clock: new FakeClock() }));
    controller.abort();
    const res = await p;
    expect(res.ok).toBe(true);
    expect(seen.aborted).toBe(true);
  });
});
