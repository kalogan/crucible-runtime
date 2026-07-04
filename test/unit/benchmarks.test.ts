import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkSpecSchema } from '../../src/bench/spec.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BENCH_DIR = path.join(REPO_ROOT, 'benchmarks');

function benchmarkDirs(): string[] {
  return fs
    .readdirSync(BENCH_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(BENCH_DIR, e.name, 'benchmark.json')))
    .map((e) => e.name);
}

describe('committed benchmark specs', () => {
  const dirs = benchmarkDirs();

  it('at least the two known benchmarks exist', () => {
    expect(dirs).toContain('fix-failing-test');
    expect(dirs).toContain('implement-missing-function');
  });

  it.each(dirs)('%s: benchmark.json parses and is internally consistent', (name) => {
    const raw = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, name, 'benchmark.json'), 'utf8'));
    const spec = benchmarkSpecSchema.parse(raw);

    // id matches directory; fixture exists; seeds match declared count.
    expect(spec.id).toBe(name);
    expect(fs.existsSync(path.join(BENCH_DIR, name, spec.fixture.path))).toBe(true);
    expect(spec.runs.seeds.length).toBe(spec.runs.count);
    expect(spec.scoring.requiredPasses).toBeLessThanOrEqual(spec.runs.count);

    // Every allowed tool is a real builtin name (guards against typos that
    // would only surface mid-run on the benchmark machine).
    const KNOWN = ['read_file', 'list_dir', 'grep', 'glob', 'write_file', 'edit_file', 'run_command'];
    for (const t of spec.tools.allowed) expect(KNOWN).toContain(t);
  });
});
