# Hardening Tracker

*Implementation hardening items from the 2026-07-03 adversarial review of the
v0.1 kernel, classified by the Director by **when they become mandatory**.
These are targeted engineering improvements — not design changes, not
features. The v0.1 implementation contract ([V0.1_SPEC.md](V0.1_SPEC.md))
stands; item R1 landed as spec amendment A1.*

Verdict recorded at classification: none of these invalidate the
`fix-failing-test` benchmark itself. R1 was the only item touching benchmark
*validity* (a truncated system prompt would mis-attribute runtime failure as
model failure), which is why it was required before Ring 3 and is now
implemented. The v0.2 items become correctness/security requirements only when
additional tools, git integration, and parallel execution arrive; the v0.4
item matters only once crash-resume exists.

## Before Ring 3 — required ✅ DONE

### R1. Context overflow guard — `context_overflow` failure reason ✅

**Risk:** Ollama never errors on an over-window prompt — it silently truncates
from the front, evicting the system prompt first. A Ring-3 run could be scored
as *model unreliability* when the model had literally lost its instructions,
or quietly pass in degraded conditions and pollute the longitudinal baseline.

**Landed (this is NOT the v0.4 context manager):** after every inference the
loop compares the provider-reported prompt size (`prompt_eval_count` — the
prompt as the model actually saw it) against the capability table's context
window; at ≥ 90% (`CONTEXT_OVERFLOW_THRESHOLD`, `src/core/loop.ts`) the turn
fails with outcome `context_overflow`, journaled with a `session_error`
detailing tokens used vs window. The harness maps it to the new
`failure_reason: 'context_overflow'` (spec amendment A1) — distinct from every
model-attributable failure. Covered in Ring 1 (loop unit test) and Ring 2
(harness integration variant). The benchmark never measures a model on a
truncated system prompt.

## Before v0.2 — required hardening ✅ DONE (v0.2)

*All three landed with v0.2 (commit `feat(v0.2): tool hardening + policy +
edit_file/glob`). Gate 74/74; v0.1 benchmark allowlist unchanged, so the 5-run
baseline is unaffected.*

### H1. Cooperative tool cancellation with a composed AbortSignal ✅

**Landed:** `src/tools/registry.ts` composes `ctx.signal` (session) with a
per-execution timeout controller via `AbortSignal.any`; the tool executes with
the composed signal. A timeout now aborts that signal, so the tool is
*cancelled*, not abandoned — `run_command` kills its process tree on the
composed signal, sync walks bail at their next boundary. A tool that heeds but
can't return instantly is still capped by the executor (race → `timeout`), so
no tool outlives its slot. Timeout remains injected-clock-driven (deterministic).
Tested both directions (timeout-fires-and-caps, session-abort-reaches-tool).

**Original debt:** the executor timeout was a `Promise.race` — when the timeout
won, the tool was *abandoned, not cancelled*; a late write could land after
`hashFiles` snapshots and corrupt the verdict.

### H2. Explicit timeout semantics for synchronous tools ✅

**Landed:** the honest decision is *non-preemptible + bounded*. `grep` /
`list_dir` / `glob` check the composed signal at directory boundaries (catching
already-aborted / between-call cancellation) and keep their hard input caps
(`MATCH_CAP`, `LIST_ENTRY_CAP`, `GLOB_CAP`, char budgets) as the real backstop —
a sync walk cannot be interrupted mid-directory, and the code + comments now say
so plainly instead of implying `timeoutMs` protects them.

### H3. Environment allowlisting for run_command ✅

**Landed:** `run_command` spawns with `buildCommandEnv()` (`src/tools/env.ts`) —
a platform-aware allowlist of non-secret OS/toolchain infra vars (PATH, HOME,
locale, and the Windows system set pnpm/node need), matched case-insensitively,
forcing `CI=true`. The ambient environment (and every host secret in it) is
never forwarded. Validated: the Ring-2 honest-fixer runs real `pnpm test`
through `run_command` under the allowlist.

*(Historical debt notes retained below for context.)*

### H1 (original). Cooperative tool cancellation with a composed AbortSignal

**Debt:** the executor timeout (`src/tools/registry.ts`) is a `Promise.race` —
when the timeout wins, the tool is *abandoned, not cancelled*. Nothing
propagates: `ctx.signal` is session-level and the timeout guard aborts only
its own sleep. An abandoned tool keeps running concurrently with the next
INFER step and, worst case, with post-run verification — a late write landing
after `hashFiles` snapshots corrupts the verdict in either direction.

**Required:** each execution gets an `AbortSignal` composed from
session-abort + executor-timeout; tools are contractually required to honor
it (run_command's process-group kill wired to it, fs/search checking it at
iteration boundaries). No tool may outlive its executor slot. Precondition for
parallel tool execution.

### H2. Explicit timeout semantics for synchronous tools

**Debt:** `read_file`, `list_dir`, `grep`, `write_file` are fully synchronous;
sync code blocks the event loop, so the executor's timeout race *cannot fire
while they run*. Their `timeoutMs` is decorative — a pathological workspace
wedges the entire session, including the wall-clock budget check and the
transcript.

**Required:** an explicit, documented decision per tool — either declare them
uninterruptible and bound their inputs (entry caps, size caps, cooperative
abort checks inside the walk loops), or make the walks async with signal
checks. What must go: the false impression that `timeoutMs` protects them.

### H3. Environment allowlisting for run_command

**Debt:** `run_command` spawns with the full inherited `process.env`
(`src/tools/builtin/exec.ts`). Harmless in the sealed fixture; in
`crucible chat` on a real workspace, every credential in the host shell is
visible to any agent-issued command today — and v0.2's git integration makes
credentialed environments the norm.

**Required:** spawn with an explicit allowlist (PATH, HOME, LANG, CI, plus
per-role additions), never the ambient environment. Deny-by-default.

## Before v0.4 — durability vs replay, tracked separately

### D1. Durable write-ahead persistence (crash-safe journal tail)

**Scope note (documented in code — `src/host/transcript.ts`,
`src/core/events.ts`):** v0.1 guarantees **deterministic replay after
successful completion** — proven by per-run replay validation. It does **not**
guarantee crash-safe durability: per-event writes go through the OS page
cache; fsync happens at header and close only. A process dying mid-turn may
lose the journal tail.

This is deliberate, not accidental: v0.1 scores completed runs only, and a
crashed run is a failed run regardless of its journal. The guarantee upgrade
(per-event or group fsync, torn-tail recovery on read) lands with the
persistence/resume work in v0.4 — salvage (v0.7) and resume-cold depend on the
tail surviving, and must not be built on today's writer.

### D2. Replay validation is symmetrically lossy (JSON projection)

Related, same milestone: both sides of the replay comparison pass through the
same JSON serialization, so values JSON cannot represent (`Infinity`,
`undefined`-vs-absent, a future Buffer in a tool output) are mangled
identically on both sides and compare equal. Today all tool outputs are
JSON-safe by construction. When the journal becomes the resume substrate
(v0.4), add a serialization-safety check at the event sink (reject non-JSON
values loudly) so the audit log cannot silently diverge from what happened.

## Also noted (no milestone forced)

- **Model thinking is dropped** at the Ollama translate boundary — qwen3's
  `thinking` field never reaches the journal, leaving Ring-3 debugging blind
  to the model's reasoning. Cheap to capture as an observational event field;
  worth doing alongside the first Ring-3 debugging session that misses it.
