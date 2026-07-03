# Benchmarks

Reproducible agent benchmarks (V0.1_SPEC.md §8). The harness is generic:
a benchmark is a directory containing a `benchmark.json` (`BenchmarkSpec`)
and a `fixture/` project. Adding a benchmark never requires harness changes.

## Running

Requires a local [Ollama](https://ollama.com) with the pinned model pulled:

```bash
ollama pull qwen3:14b
pnpm bench fix-failing-test              # the v0.1 exit gate: 5 runs, seeds 1–5
pnpm bench fix-failing-test --model qwen3:8b --runs 1   # comparison run (non-blocking)
```

Each run stages a fresh copy of the fixture in the scratch dir
(`CRUCIBLE_SCRATCH_DIR`, default `$TMPDIR/crucible-scratch`), runs one agent
session against it, then **independently verifies** the outcome — the harness
re-runs the test command itself and reads the real exit code; the agent's
claim is never the signal. After every run the JSONL transcript is replayed
through the runtime and must reconstruct the identical final session state.

## Scoring

`fix-failing-test` passes when **≥ 4 of 5** seeded runs pass (Director
decision, 2026-07-03). A run passes only if:

- the harness's own `pnpm test` re-run exits 0,
- protected files (tests, configs, lockfile) are byte-identical,
- the transcript shows a failing test run observed *before* the first write,
- replay validation reconstructs the identical session state,
- budgets were respected (≤ 24 iterations, ≤ 10 min wall-clock).

Reports land in `benchmarks/results/` with the full per-run metric set
(tool calls, invalid calls, retries, tokens, wall-clock, iterations, failure
reasons) plus aggregates — the standing regression record: the pass rate must
never drop as the runtime evolves.
