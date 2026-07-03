# Crucible Runtime

An open-source, **provider-agnostic AI agent runtime** in TypeScript — built to
execute the [Architect–Builder pipeline](docs/PIPELINE.md): one Architect agent
that plans, dispatches, supervises, and *independently verifies*; many Builder
agents working disjoint slices in parallel; Validators gating everything with
real exit codes.

- **Local-first:** Ollama is the initial provider (native tool calling), with
  Claude / OpenAI / Gemini / any OpenAI-compatible server swappable behind one
  `Provider` interface.
- **Native tool calling only** — structured tool calls, never text-parsing.
- **Clean seams:** prompts (data) / runtime core / providers / tools / agent
  roles are separate layers with enforced boundaries.
- **Trust nothing:** builder reports are untrusted input; liveness is
  file-mtime + commits; gates run with real exit codes under hard timeouts.

**Status: design phase.** No code yet — the full architecture, interfaces, and
the v0.1 → v1.0 implementation plan live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture, folder
  structure, runtime loop, tool/provider interfaces, agent lifecycle, context
  management, phased plan.
- [`docs/PIPELINE.md`](docs/PIPELINE.md) — the Architect–Builder methodology
  this runtime exists to run.
