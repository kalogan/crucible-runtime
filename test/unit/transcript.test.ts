import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTranscriptWriter,
  readJournal,
  reconstructSession,
  stableStringify,
} from '../../src/host/transcript.js';
import { AgentSession } from '../../src/core/session.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ok } from '../../src/tools/types.js';
import type { Tool } from '../../src/tools/types.js';
import { z } from 'zod';
import { FakeClock, fakeIds } from '../fakes/clock.js';
import { FakeProvider } from '../fakes/provider.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-transcript-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const noopTool: Tool<{ x?: string | undefined }, { done: boolean }> = {
  name: 'noop',
  description: 'does nothing',
  inputSchema: z.object({ x: z.string().optional() }),
  safety: 'safe',
  parallelSafe: true,
  timeoutMs: 1_000,
  execute: async () => ok({ done: true }, 'noop done'),
};

async function runScriptedSession(journalPath: string) {
  const transcript = createTranscriptWriter(journalPath, { model: 'fake', seed: 1 });
  const session = AgentSession.create({
    role: 'test',
    systemPrompt: 'sys',
    provider: new FakeProvider([
      { kind: 'tool_calls', calls: [{ name: 'noop', arguments: {} }] },
      { kind: 'text', content: 'finished' },
    ]),
    model: 'fake',
    chatOptions: {},
    tools: new ToolRegistry().register(noopTool),
    workspace: dir,
    budgets: { maxIterations: 10, wallClockMs: 60_000 },
    clock: new FakeClock(),
    ids: fakeIds(),
    sink: transcript.sink,
  });
  const result = await session.runTurn('do it');
  transcript.close();
  return { session, result };
}

describe('transcript', () => {
  it('round-trips: journal reconstructs the identical final session state', async () => {
    const journalPath = path.join(dir, 'roundtrip.jsonl');
    const { session } = await runScriptedSession(journalPath);

    const journal = readJournal(journalPath);
    expect(journal.header?.journalVersion).toBe(1);
    expect(journal.header?.config).toEqual({ model: 'fake', seed: 1 });

    const reconstructed = reconstructSession(journal);
    expect(stableStringify(reconstructed)).toBe(stableStringify(session.state()));
  });

  it('detects a seq gap (corrupted journal) on reconstruction', async () => {
    const journalPath = path.join(dir, 'gap.jsonl');
    await runScriptedSession(journalPath);

    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    // Drop one mid-journal event line (keep header at index 0).
    const corrupted = [...lines.slice(0, 3), ...lines.slice(4)].join('\n') + '\n';
    fs.writeFileSync(journalPath, corrupted);

    expect(() => reconstructSession(readJournal(journalPath))).toThrow(/seq gap/);
  });

  it('fails reconstruction when the journal has no turn_started', () => {
    const journalPath = path.join(dir, 'empty.jsonl');
    const writer = createTranscriptWriter(journalPath, {});
    writer.close();
    expect(() => reconstructSession(readJournal(journalPath))).toThrow(/turn_started/);
  });
});

describe('stableStringify', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('treats explicit-undefined keys as absent (JSON round-trip semantics)', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});
