# Crucible Runtime — Architecture

*An open-source, provider-agnostic AI agent runtime in TypeScript, designed to
execute the [Architect–Builder pipeline](https://github.com/kalogan/crucible-asset-studio/blob/main/docs/ARCHITECT_BUILDER_PIPELINE.md):
one Architect that grills, plans, dispatches, supervises, and independently
verifies; many Builders working disjoint slices in parallel; Validators that
gate everything with real exit codes.*

> **Status:** v0-design. No code exists yet; this document is the contract the
> first implementation phases build against. Ollama is the first provider;
> nothing in the core may depend on it.

---

## 1. Purpose and scope

This is **not** a Claude Code clone. It recreates the *capabilities the
Architect–Builder workflow depends on*, and nothing else:

| Pipeline need (§ refs → ARCHITECT_BUILDER_PIPELINE.md) | Runtime capability |
|---|---|
| An agent that reasons and acts in a loop | Turn-based runtime loop with native tool calling |
| Grill the Director with structured questions (§E) | `ask_director` tool + a blocking question queue |
| Dispatch self-contained background Builders (§3, §A) | Agent sessions as supervised child processes with role + brief |
| Supervise by mtime + commits, never self-report (§4, §C, §D) | Artifact-based supervisor; liveness is filesystem/git state |
| Verify with real exit codes under timeouts (§5, §B) | Gate runner: exec with captured exit codes, hard timeouts, recorded counts |
| Salvage → relaunch, checkpoint constantly (§6) | Commit-per-layer discipline enforced via tool policy; continuation briefs |
| Durable memory + review queue + resume-cold (§7, §G) | File-based persistence: status, transcripts (JSONL), review queue |
| Safety boundaries — never destructive unattended (§8) | Tool-level policy engine: `safe` / `confirm` / `forbidden-unattended` |
| Provider-agnostic, local-first | `Provider` interface; Ollama adapter first, Anthropic/OpenAI/Gemini later |

Out of scope (deliberately): IDE integration, a TUI beyond a plain CLI,
multi-user auth, hosted service concerns, MCP *hosting* (MCP *consumption* is a
future adapter — §15).

## 2. Non-negotiable constraints

These are the standing rules handed to every builder of this repo and enforced
by the gate — the same discipline Crucible Asset Studio uses.

1. **Core is provider-blind.** `core/`, `agents/`, `tools/`, `context/` never
   import a provider SDK or mention a provider name. Only `providers/<name>/`
   may. Enforced by a lint arch-guard, not by hope.
2. **Native tool calling only.** Providers must expose structured tool calls
   (`{ id, name, arguments: object }`). No regex-parsing of assistant text to
   find commands, ever. A model that can't do native tools is declared
   incompatible in the model registry, not worked around.
3. **Zod is the source of types.** Every tool input, provider config, agent
   role file, and persisted record has a Zod schema; TypeScript types derive
   from schemas (`z.infer`), never the reverse. Tool JSON Schemas are
   *generated* from the same Zod schemas.
4. **Deterministic core.** Inject `clock` and `rng` everywhere; no `Date.now()`
   or `Math.random()` in core paths. This is what makes the runtime loop unit-
   testable with a scripted fake provider.
5. **Everything persisted is versioned.** Transcripts, status files, and role
   files carry a schema version and migrate forward; golden fixtures ship with
   every schema change.
6. **Every long-running exec is under a hard timeout.** The gate runner and the
   `bash` tool wrap commands in timeouts; exit 124 is a *hang to investigate*,
   never a pass.
7. **Data-driven registries, not if-ladders.** Models, tools, providers, and
   agent roles are registry entries; adding one is data + one module, no core
   edits.
8. **Every new system ships tests.** Runtime loop, tool dispatch, context
   compaction, and supervision heuristics are all testable against fakes.

## 3. Overall architecture

Five layers, dependencies pointing strictly downward. The names mirror the
separation you asked for: **prompts / runtime / providers / tools / agents**,
plus the orchestration layer that turns single agents into the pipeline.

```
┌────────────────────────────────────────────────────────────────────┐
│  host/            CLI entry, process mgmt, event stream, wiring    │
├────────────────────────────────────────────────────────────────────┤
│  orchestration/   Architect's levers: dispatcher, supervisor,      │
│  (v0.6+)          gate runner, review queue, salvage/relaunch      │
├────────────────────────────────────────────────────────────────────┤
│  agents/          roles (Architect, Builder, Validator):           │
│                   prompt pack + tool allowlist + policy + limits   │
├──────────────────────────────┬─────────────────────────────────────┤
│  core/                       │  context/                           │
│  runtime loop, session,      │  token ledger, window assembly,     │
│  turn state machine, events  │  compaction, durable memory         │
├──────────────┬───────────────┴──────────────┬──────────────────────┤
│  tools/      │  providers/                  │  prompts/ (data)     │
│  interface,  │  Provider interface,         │  markdown templates, │
│  registry,   │  model registry,             │  loaded + interpolated│
│  policy,     │  adapters: ollama/ …         │  at session start    │
│  builtins    │  (anthropic/, openai/ later) │                      │
└──────────────┴──────────────────────────────┴──────────────────────┘
```

Key relationships:

- **`core` knows interfaces, never implementations.** It receives a `Provider`,
  a `ToolRegistry`, a `ContextManager`, and an `AgentRole` at session start and
  runs the loop. Swap Ollama for Claude and core doesn't recompile differently.
- **`agents` are data + policy, not subclasses.** An agent role is a manifest
  (which prompts, which tools, which limits, which safety mode). The Architect
  and a Builder run the *same* loop with different manifests.
- **`orchestration` is just an agent using privileged tools.** The Architect
  supervises Builders through tools (`dispatch_builder`, `check_liveness`,
  `run_gate`, `salvage`) — the pipeline's steps become tool calls, so the
  methodology itself is legible in transcripts.
- **`prompts` are files, not string literals.** Versioned markdown with
  `{{placeholders}}`, so prompt iteration never touches TypeScript.

## 4. Folder structure

```
crucible-runtime/
├── docs/
│   ├── ARCHITECTURE.md            # this document
│   └── PIPELINE.md                # vendored copy of the Architect–Builder methodology
├── prompts/                       # prompt packs — DATA, versioned, no code
│   ├── architect/
│   │   ├── system.md              # identity, the 8 steps, safety boundaries
│   │   ├── grill.md               # structured-question pattern
│   │   └── dispatch.md            # builder dispatch prompt template (§A)
│   ├── builder/
│   │   └── system.md              # scope discipline, commit-per-layer, gate rules
│   ├── validator/
│   │   └── system.md              # re-run everything, trust nothing
│   └── shared/
│       ├── constraints.md         # the project's non-negotiables (injected everywhere)
│       └── tool-guidance.md       # cross-role tool usage norms
├── src/
│   ├── core/
│   │   ├── session.ts             # AgentSession: owns one agent's message log + loop
│   │   ├── loop.ts                # the turn state machine (§5)
│   │   ├── events.ts              # typed event bus (turn/tool/provider/lifecycle events)
│   │   ├── errors.ts              # taxonomy: retryable / fatal / policy-denied / timeout
│   │   └── ids.ts                 # injected id generation (deterministic in tests)
│   ├── providers/
│   │   ├── types.ts               # Provider + ChatRequest/Response/Event (§7)
│   │   ├── registry.ts            # provider + model registry (capabilities table)
│   │   ├── retry.ts               # withRetry: exp backoff + jitter, Retry-After aware
│   │   └── ollama/
│   │       ├── provider.ts        # /api/chat adapter
│   │       ├── translate.ts       # runtime messages ⇄ Ollama wire format
│   │       └── models.ts          # model capability entries (tools? ctx window? …)
│   ├── tools/
│   │   ├── types.ts               # Tool, ToolContext, ToolResult (§6)
│   │   ├── registry.ts            # name → tool; Zod → JSON Schema generation
│   │   ├── policy.ts              # safety classes, allowlists, unattended rules
│   │   └── builtin/
│   │       ├── fs.ts              # read_file, write_file, list_dir, glob, grep
│   │       ├── exec.ts            # run_command (timeout-wrapped, exit-code honest)
│   │       ├── git.ts             # status/log/diff/add(targeted)/commit — no destructive verbs
│   │       └── director.ts        # ask_director (structured questions), notify_director
│   ├── agents/
│   │   ├── role.ts                # AgentRole schema: prompts + tools + limits + policy
│   │   ├── lifecycle.ts           # state machine (§9)
│   │   └── roles/                 # role manifests (data): architect.ts, builder.ts, validator.ts
│   ├── context/
│   │   ├── ledger.ts              # token accounting per section
│   │   ├── assemble.ts            # layered window assembly (§10)
│   │   ├── compact.ts             # summarization + tool-result truncation
│   │   └── memory.ts              # durable file-backed memory (status, decisions)
│   ├── orchestration/             # v0.6+ — the Architect's levers
│   │   ├── dispatcher.ts          # spawn builder sessions as child processes
│   │   ├── supervisor.ts          # liveness = surface mtime + commits (§D table)
│   │   ├── gate.ts                # gate runner: real exit codes, timeouts, counts
│   │   ├── salvage.ts             # wip-checkpoint + continuation-brief generation
│   │   └── review-queue.ts        # taste items surfaced to the Director, non-blocking
│   ├── host/
│   │   ├── cli.ts                 # `crucible chat|run|dispatch|status`
│   │   ├── config.ts              # env + config file (Zod-validated)
│   │   └── transcript.ts          # JSONL journal per session (append-only)
│   └── index.ts                   # public library surface
├── test/
│   ├── fakes/                     # FakeProvider (scripted), FakeClock, in-mem fs
│   └── golden/                    # transcript + schema fixtures
├── package.json
└── tsconfig.json                  # strict, noUncheckedIndexedAccess
```

Rationale for the seams:

- `prompts/` at the **repo root**, not under `src/` — they're editable data with
  their own review cadence (prompt changes shouldn't look like code changes).
- `orchestration/` separate from `agents/` — a Builder never links the
  supervisor; only the Architect's role manifest grants orchestration tools.
- `host/` is the only layer allowed to touch `process.env`, stdout, and signal
  handling. Everything below is a pure library (usable embedded, e.g. from
  Asset Studio later).

## 5. Runtime loop

One **session** = one agent instance = one message log. One **turn** = one
user/dispatcher input processed to completion. The loop is a small state
machine; every transition emits a typed event (for transcripts, the CLI, and
the supervisor).

```
            ┌──────────────────────────────────────────────────────┐
            │ input (user msg / dispatch brief / tool-result resume)│
            └──────────────┬───────────────────────────────────────┘
                           ▼
              ┌─────────────────────────┐
        ┌────▶│ ASSEMBLE                │  context/: system prompt + memory +
        │     │ build provider request  │  brief + rolling window + tool schemas
        │     └────────────┬────────────┘  (token ledger decides what fits)
        │                  ▼
        │     ┌─────────────────────────┐
        │     │ INFER                   │  provider.chat() → assistant message
        │     │ (withRetry: 429/5xx)    │  with text and/or toolCalls[]
        │     └────────────┬────────────┘
        │                  ▼
        │        toolCalls present?
        │           │           │
        │          yes          no ──────────► TURN COMPLETE
        │           ▼                          (final text = the agent's report)
        │     ┌─────────────────────────┐
        │     │ EXECUTE (per call)      │  1. registry lookup (unknown → error result)
        │     │                         │  2. policy check (denied → error result,
        │     │                         │     or PAUSED-FOR-APPROVAL if 'confirm')
        │     │                         │  3. Zod-validate args (fail → error result,
        │     │                         │     model sees the validation message)
        │     │                         │  4. run under per-tool timeout + AbortSignal
        │     └────────────┬────────────┘
        │                  ▼
        │     append tool-result messages
        └──────────────────┘   (loop; guards: max-iterations, token budget,
                                 wall-clock budget, abort → CANCELLED)
```

Rules that matter:

- **Tool errors are messages, not exceptions.** Validation failures, policy
  denials, and timeouts come back to the model as structured tool results so it
  can self-correct. Only infrastructure failures (provider down after retries)
  abort the turn.
- **Independent tool calls in one assistant message execute concurrently**, with
  results appended in call order. Tools declare `parallelSafe: boolean`; the
  executor serializes anything that isn't (e.g. `git commit`).
- **Guards are role-scoped.** A Builder gets a generous max-iterations (it works
  alone for a long time); a Validator gets a tight one (it should only run the
  gate and report).
- **`PAUSED-FOR-APPROVAL` is a first-class session state**, not a crash: the
  session persists, the Director answers (via CLI or the review queue), and the
  turn resumes with the decision injected as the tool result. This is how §8
  safety boundaries work mid-flight.
- **Every state transition is journaled** to the session's JSONL transcript
  before it takes effect (write-ahead), so a killed process resumes from the
  exact step.

## 6. Tool interface

```ts
// tools/types.ts — shapes only; final signatures land in v0.1

interface Tool<In = unknown, Out = unknown> {
  name: string;                        // snake_case, stable across versions
  description: string;                 // written FOR THE MODEL (when + how to use)
  inputSchema: z.ZodType<In>;          // single source of truth →
                                       //   JSON Schema for the provider,
                                       //   runtime validation for the executor
  safety: 'safe'                       // read-only / idempotent — always allowed
        | 'mutating'                   // writes within the workspace — allowed per role
        | 'confirm'                    // needs Director approval when unattended
        | 'forbidden-unattended';      // never without a live Director (§8 list)
  parallelSafe: boolean;
  timeoutMs: number;                   // hard cap; executor enforces, not the tool
  execute(input: In, ctx: ToolContext): Promise<ToolResult<Out>>;
}

interface ToolContext {
  workspace: string;                   // absolute root; fs tools refuse paths outside it
  surface?: string[];                  // Builder file-surface allowlist (disjointness!)
  signal: AbortSignal;
  clock: Clock;                        // injected — constraint #4
  emit: (event: ToolEvent) => void;    // progress events for transcript + supervisor
  session: SessionRef;                 // id + role, for attribution
}

type ToolResult<Out> =
  | { ok: true;  output: Out; forModel: string /* rendered, truncation-aware */ }
  | { ok: false; error: ToolError; forModel: string };
```

Decisions baked in:

- **`forModel` is a rendering, `output` is the data.** The context manager
  truncates/summarizes `forModel` under budget pressure; the structured
  `output` stays intact in the transcript for the supervisor and for replay.
- **The file surface is enforced in `ToolContext`, not in prompts.** A Builder
  dispatched with `surface: ['src/tools/**']` gets *hard-denied* writes outside
  it — disjointness (pipeline §6) becomes mechanical, not behavioral.
- **`git.ts` exposes no destructive verbs at all.** There is no
  `reset --hard`, no force-push, no `add .` — targeted `add(files: string[])`
  only. The §8 boundary isn't a policy check on a dangerous tool; the dangerous
  tool doesn't exist. (The Architect's `run_command` can still be granted for
  edge cases, gated `confirm`.)
- **Registry generates the provider payload.** `zod-to-json-schema` (or
  equivalent) converts `inputSchema` once at registration; providers receive
  plain JSON Schema and never see Zod.

Built-in set at v0.1 (deliberately tiny): `read_file`, `list_dir`, `glob`,
`grep`, `write_file`, `run_command`, `ask_director`. Everything else arrives
with the phase that needs it.

## 7. Provider interface

```ts
// providers/types.ts — shapes only

interface Provider {
  id: string;                                    // 'ollama' | 'anthropic' | …
  models(): Promise<ModelInfo[]>;                // discovery, where supported
  capabilities(model: string): ModelCapabilities;
  chat(req: ChatRequest): Promise<ChatResponse>; // v0.1: request/response
  chatStream?(req: ChatRequest): AsyncIterable<ChatEvent>; // v0.4+: optional
}

interface ModelCapabilities {
  nativeTools: boolean;        // hard requirement — false ⇒ model is unusable here
  parallelToolCalls: boolean;
  contextWindow: number;       // tokens; drives the context ledger
  supportsSystemPrompt: boolean;
  promptCaching: 'none' | 'prefix' | 'explicit';  // explicit = Anthropic cache_control
}

interface ChatRequest {
  model: string;
  messages: RuntimeMessage[];  // the runtime's OWN message model (below)
  tools: JsonSchemaTool[];     // generated from the tool registry
  options: { temperature?: number; maxTokens?: number; signal: AbortSignal };
}

interface ChatResponse {
  message: AssistantMessage;   // content + toolCalls, normalized
  usage: { inputTokens: number; outputTokens: number };  // feeds the ledger
  stopReason: 'end' | 'tool_calls' | 'max_tokens' | 'aborted';
}
```

**The normalized message model** is the core abstraction that makes provider
swaps real. Adapters translate at the boundary; nothing upstream knows wire
formats:

```ts
type RuntimeMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool';      toolCallId: string; name: string; content: string };

interface ToolCall {
  id: string;              // Ollama doesn't always supply one → adapter mints it
  name: string;
  arguments: unknown;      // ALWAYS a parsed object at this layer:
}                          //   Ollama/Anthropic give objects natively;
                           //   OpenAI gives a JSON string → adapter parses it
```

### Ollama adapter specifics (first provider)

- Targets `POST /api/chat` with the `tools` array; reads
  `message.tool_calls[].function.{name,arguments}`. Ollama returns `arguments`
  as a parsed object — the normalized layer above matches it exactly.
- **Model capability registry is data, not detection.** Ollama has no reliable
  "supports tools?" API; the adapter ships a curated table (qwen3, qwen2.5,
  llama3.1+, mistral-nemo, devstral, …) with context windows and a
  `nativeTools` flag, overridable in config. Requesting tools from a non-tool
  model fails loud at session start, not confusingly mid-turn.
- **Set `num_ctx` explicitly** from the capability entry — Ollama's default
  (often 2–8k) silently truncates agent contexts, which manifests as the model
  "forgetting" its tools. This is the #1 local-model footgun; the adapter
  refuses to run with an unconfigured window.
- Retry discipline per the Asset Studio kernel lessons: one `withRetry` at the
  adapter boundary — exponential backoff + jitter, `Retry-After`-aware,
  retrying 429/5xx/connection-reset. Never sprinkled at call sites.
- v0.1 is non-streaming (request/response) — tool-call streaming across
  providers is inconsistent, and nothing in the pipeline needs tokens live.
  `chatStream` arrives in v0.4 for CLI feel, with a buffering fallback for
  providers/models that can't stream tool calls.

### Later adapters

Anthropic (Claude), OpenAI, and Gemini adapters each live in their own folder,
translate to/from `RuntimeMessage`, and declare capabilities (e.g. Anthropic:
`promptCaching: 'explicit'`, which the context manager exploits by marking the
stable prefix). An **OpenAI-compatible** adapter doubles as the path to many
local servers (vLLM, LM Studio, llamafile) for free.

## 8. Prompt system

- Prompt packs are **markdown files with `{{placeholder}}` interpolation** —
  no logic in templates. Anything conditional is decided in TypeScript and
  passed in as a value.
- A role's system prompt is assembled from parts:
  `shared/constraints.md` + `<role>/system.md` + project-specific constraints
  (from config) — mirroring how the pipeline injects non-negotiables into
  every builder.
- The **dispatch brief** (pipeline §A: scope, context, constraints, git
  discipline, gate) is a template in `prompts/architect/dispatch.md` that the
  Architect fills via the `dispatch_builder` tool's arguments — so the
  methodology's most important artifact is versioned, diffable data.
- Prompts carry a frontmatter version; transcripts record which prompt versions
  a session ran with (the "recipe snapshot" instinct from Asset Studio).

## 9. Agent roles and lifecycle

An **AgentRole** is a Zod-validated manifest — data, not a class:

```ts
interface AgentRole {
  name: 'architect' | 'builder' | 'validator' | string;  // extensible
  promptPack: string;                  // prompts/<name>/
  tools: string[];                     // allowlist into the registry
  policy: {
    unattendedOk: boolean;             // builders yes; confirm-class tools pause
    maxIterationsPerTurn: number;
    maxTokensPerSession: number;       // cost guardrail, Asset Studio-style
    wallClockBudgetMs: number;
  };
  provider: { id: string; model: string };  // per-role! architect can run a
}                                           // stronger model than builders
```

Role intents:

- **Architect** — the only role with orchestration tools (`dispatch_builder`,
  `check_liveness`, `run_gate`, `salvage`, `ask_director`) and the only one
  that talks to the Director. Long-lived session.
- **Builder** — fs + exec + targeted-git tools, hard file-surface, no network,
  no Director access (blockers go in its final report). Background child
  process; its transcript is its evidence.
- **Validator** — `run_gate` + read-only fs. Exists so verification is a
  *separate context* from the builder being verified — trust nothing, re-run
  everything. (In v0.8 the Architect may run gates itself; the Validator role
  makes verification parallelizable and keeps the Architect's context small.)

### Lifecycle state machine

```
 created ──brief──▶ running ◀──────────────┐
                      │  │                  │ resume (approval / continuation)
                      │  ├──▶ paused-for-approval
                      │  │
                      │  ├──▶ completed (final report, exit 0)
                      │  │
                      │  └──▶ failed (reported blocker — honest red)
                      │
        (supervisor-observed, not self-reported)
                      │
                      ├──▶ stalled ──salvage──▶ checkpointed ──relaunch──▶ (new
                      └──▶ dead    ──salvage──▶ checkpointed ──relaunch──▶  session,
                                                                continuation brief)
```

Two kinds of transitions, deliberately kept apart:

- **Self-transitions** (`running → completed/failed/paused`) come from the
  agent's own loop and are recorded as *claims*.
- **Observed transitions** (`→ stalled/dead`) come only from the supervisor
  applying the pipeline's §D table — *newest source mtime in the builder's
  surface stale > threshold AND no new commit* → dead, regardless of whether
  the process is running. Process liveness is explicitly **not** a signal
  (the zombie-gate lesson).

A `completed` claim triggers verification (gate re-run by Architect/Validator);
only a verified-green result advances the slice. **Salvage** commits the
surface's uncommitted work as a `wip(...)` checkpoint and generates a
continuation brief from the transcript + checkpoint — nothing is ever lost.

## 10. Context management strategy

Local models make this the hardest problem: an 8–32k window has to carry what
Claude-class models do in 200k. The strategy is **layered assembly under a
token ledger**, with durable memory *outside* the window.

Window layout, assembled fresh every INFER step (stable → volatile, which also
maximizes prefix-cache hits on providers that have them — including Ollama's
KV-cache reuse):

```
┌──────────────────────────────────────────────┐
│ 1. system prompt (role + constraints)         │  stable — never changes mid-session
│ 2. tool schemas                               │  stable per session
│ 3. task brief (dispatch prompt)               │  stable per turn
│ 4. memory digest                              │  compact summary of durable memory
│ 5. compacted history (summaries of old turns) │  grows slowly
│ 6. recent messages, verbatim                  │  the working set
└──────────────────────────────────────────────┘
```

Mechanisms, in the order they engage as pressure rises:

1. **Ledger first.** Every message is token-counted on append (fast heuristic
   locally, provider usage numbers as ground truth). Assembly knows *before*
   calling the provider whether the request fits; it never discovers overflow
   as a 500.
2. **Tool-result truncation.** Tool results dominate agent context growth.
   Each tool declares how its `forModel` rendering degrades (e.g. `read_file`:
   head+tail with a `…N lines omitted…` marker; `run_command`: last N lines,
   which is where errors live). Full output always survives in the transcript.
3. **Compaction.** When the working set crosses a high-water mark (~70%), the
   oldest turns are summarized — *by the same provider, as a hidden turn* —
   into layer 5, preserving: decisions made, files touched, gate results,
   open items. The summary is journaled, so compaction is replayable.
4. **Durable memory over big windows.** The pipeline's own answer (§G): state
   lives in files — `STATUS.md`-style memory the agent updates via tools
   (`memory.ts` wraps this), designed so a **fresh session can resume cold**
   from memory + git log alone. Compaction losing detail is acceptable
   *because* the durable record exists.
5. **Surface-scoped context for Builders.** A Builder's brief embeds only its
   slice: relevant file excerpts, the seams to respect, the gate. It never
   receives whole-repo context — disjointness keeps windows small by design.

What is deliberately *not* here: embeddings/RAG. At this scale, `grep` + memory
files + tight briefs beat a vector store, and they're debuggable. RAG can
arrive later as a tool, not as core machinery.

## 11. Orchestration: how the pipeline maps onto the runtime

The eight steps become concrete runtime activity — the Architect *is* an agent
session whose tool calls are the methodology:

| Pipeline step | Runtime realization |
|---|---|
| 1. Grill | `ask_director` tool → structured questions; session pauses (or queues, if Director AFK) |
| 2. Plan | Architect writes the plan into durable memory; slices declare file surfaces |
| 3. Dispatch | `dispatch_builder(brief, surface, role, model)` → child-process session |
| 4. Supervise | `supervisor.ts` wakes on a heartbeat: surface mtimes + `git log` per builder; §D table verbatim |
| 5. Verify | `run_gate(commands[])` — each under `timeout`, real exit codes captured, test counts parsed and recorded against the last known green |
| 6. Recover | `salvage(sessionId)` → targeted `wip` commit + continuation brief → `dispatch_builder` again |
| 7. Persist | memory tool writes status; `review-queue.ts` accumulates taste items |
| 8. Advance | Architect reports (CLI/notification), consults the safety-boundary policy before the next slice |

The supervisor heartbeat is host-level (a timer in the Architect's host
process), not model-level — waking the model to check mtimes would burn tokens
for filesystem stats. The model is woken only when the heuristic *fires*
(stall/death/completion-claim), with a compact digest of what changed.

## 12. Persistence and observability

- **Transcript per session**: append-only JSONL (`sessions/<id>/journal.jsonl`)
  — every message, tool call, tool result (full, untruncated), state
  transition, token usage, and prompt/config versions. Written ahead of state
  changes; the single source for resume, replay, salvage, and debugging.
- **Durable memory**: human-readable markdown under the *target project's*
  workspace (`.crucible/STATUS.md`, `.crucible/review-queue.md`) — the Director
  can read and edit the same state the agents do.
- **Event stream**: the typed event bus mirrors to the CLI live view and to the
  journal. Nothing observable happens without an event.
- **Runs are reproducible in shape**: journal + prompt versions + model +
  config snapshot = the "recipe snapshot" of an agent run. (Token-identical
  replay is a non-goal — models are nondeterministic — but every *input* to
  every step is recoverable.)

## 13. Safety boundaries

Direct encoding of pipeline §8, enforced at the tool layer (§6 above):

- Destructive git, deletes outside the workspace, and anything network-external
  are `forbidden-unattended` or simply **not implemented as tools**.
- `confirm`-class calls while the Director is away → session pauses to the
  review queue rather than proceeding or dying.
- Builders physically can't reach the Director, the network, or files outside
  their surface — the boundary is the tool context, not the prompt.
- The Architect's own risky actions (relaunching with history rewrite, touching
  another surface) route through the same policy engine — no role is above it.

## 14. Phased implementation plan — v0.1 → v1.0

**Revised 2026-07-03:** the roadmap is restructured around proving the
project's fundamental risk first — *can a local open-weights model reliably
execute a multi-step native tool-calling loop to a verifiable engineering
outcome?* v0.1 is now the **benchmark kernel**: the smallest end-to-end runtime
that answers that question with a scored, reproducible benchmark
(`fix-failing-test`). The full v0.1 contract — interfaces, components, tools,
fixture, acceptance criteria, testing strategy — lives in
[`V0.1_SPEC.md`](V0.1_SPEC.md). The old "read-only kernel first, writes later"
split is dissolved; the benchmark needs `write_file` + `run_command` on day one.

Each phase is a shippable, gate-green slice with a demo, and **every phase
re-runs the v0.1 benchmark as a regression gate** — the 5-run pass rate must
never drop.

| Version | Slice | Capabilities landed | Exit demo ("done" means) |
|---|---|---|---|
| **0.1** | **Benchmark kernel** | Per [`V0.1_SPEC.md`](V0.1_SPEC.md): `RuntimeMessage` model, non-streaming loop, Ollama adapter (`/api/chat`, `num_ctx`, `withRetry`), 5 tools (`read_file`, `list_dir`, `grep`, `write_file`, `run_command`), write-surface enforcement, JSONL transcript, FakeProvider harness, benchmark harness + fixture | **`fix-failing-test` passes ≥ 4/5 runs on qwen3:14b with zero human intervention** |
| **0.2** | **Tools + policy** | Full safety classes, `edit_file` (string-replace), `glob`, targeted-git tool, generalized surface enforcement, parallel tool execution | Policy denial + model self-correction demo; benchmark pass rate holds |
| **0.3** | **Roles + prompts** | Prompt packs (files, versioned, interpolated), `AgentRole` manifests, Architect role runs end-to-end, `ask_director` with paused-for-approval, config system | Architect grills with structured questions, then executes a small task under its role constraints |
| **0.4** | **Context manager** | Token ledger, layered assembly, tool-result degradation, compaction via hidden summarize-turn, durable memory tool, resume-cold from journal + memory; optional `chatStream` for CLI | A session 3× the model's window completes without overflow; kill the process mid-turn, resume, finish |
| **0.5** | **Second provider** | Anthropic adapter + OpenAI-compatible adapter (covers OpenAI, vLLM, LM Studio), capability table drives differences (caching, parallel calls); **the v0.1 benchmark becomes the provider parity suite**; package split (per Director decision) | The identical benchmark passes on Ollama and Claude by changing one config line |
| **0.6** | **Builders** | `dispatch_builder` → child-process sessions, dispatch-brief template, per-role model selection, surface disjointness checked at dispatch, builder final reports | Architect dispatches 2 parallel builders on disjoint surfaces; both land targeted commits |
| **0.7** | **Supervision** | Heartbeat supervisor, §D liveness table (mtime + commits, never processes), stall/death detection, salvage → `wip` checkpoint → continuation brief → relaunch | Kill a builder mid-task; supervisor detects, salvages, relaunches; the continuation finishes the slice |
| **0.8** | **Verification** | Gate runner (per-command `timeout`, real exit codes, `PIPESTATUS`-honest, test-count parsing + drift detection), Validator role, verify-on-completion-claim wired into lifecycle | A builder that lies "all green" is caught: Validator's gate run fails, slice does not advance |
| **0.9** | **Persistence + AFK** | Review queue, status/memory conventions, notification hook (pluggable: desktop/webhook), safety-boundary pause/resume across process restarts, cost/token accounting per slice | A multi-slice run completes AFK: taste items queued, boundaries respected, full audit trail |
| **1.0** | **The pipeline, whole** | Grill→plan→dispatch→supervise→verify→recover→persist→advance as a continuous loop; hardening (error taxonomy coverage, golden transcripts, docs); public API surface frozen; semver | The runtime executes a real multi-slice feature on a real repo end-to-end with the Director checking in twice — and the repo's own gate proves it |

Standing gate for this repo from v0.1 (constraint #8 made concrete):
`typecheck` (strict) · `lint` + arch-guards (core-imports-no-provider) ·
`vitest` with recorded counts · `build`. Every phase lands green.

## 15. Future extensibility

Designed-in seams, in rough order of likely demand:

- **New providers** — one folder + capability entries. The parity test suite
  (v0.5) is the acceptance bar. Gemini, Bedrock, and any OpenAI-compatible
  server are config away.
- **MCP consumption** — an adapter that mounts a remote MCP server's tools into
  the tool registry (MCP tool schema → the registry's JSON Schema is nearly
  1:1). This multiplies available tools without touching core. *Consumption*
  first; *hosting* (exposing Crucible tools as an MCP server) only if a real
  need appears.
- **Model routing** — roles already pin provider+model, so heterogeneous fleets
  (strong cloud Architect + cheap local Builders, or fully local) are config.
  A later `router` provider could pick per-request by capability/cost.
- **New roles** — the manifest system means a Reviewer (adversarial diff
  review, pipeline §5b), a Researcher, or a Smoke-tester (boot the app,
  screenshot, scan console — the §5b runtime-smoke layer) are prompt packs +
  tool allowlists, zero core changes.
- **Embedding as a library** — `host/` is the only process-aware layer, so
  Asset Studio (or any app) can embed sessions in-process: the canon-enrichment
  Claude calls there could become runtime sessions with tools.
- **Eval harness** — golden-transcript replays against FakeProvider make
  regression-testing prompt/loop changes cheap; a later live-eval mode scores
  real models on the parity tasks (which local models are actually good enough
  to Build?).
- **A richer host** — web dashboard over the event stream + journals (live
  builder fleet view). The event bus is already the API for it.

## 16. Director decisions (2026-07-03)

The four design forks were grilled and locked — these are settled; do not
re-litigate per slice:

1. **Builder isolation: shared working tree + enforced surfaces.** All builders
   share one tree; the runtime hard-denies writes outside each builder's
   file-surface allowlist (`ToolContext.surface`). This matches the pipeline's
   proven mode and keeps mtime-based supervision simple. Worktree-per-builder
   may arrive later as a per-dispatch option, but is not planned for v1.0.
2. **Packaging: single package, split around v0.5.** One npm package with clean
   `src/` seams; split into a pnpm workspace (`@crucible/core`,
   `@crucible/provider-ollama`, …) when the second provider proves the seam.
3. **Reference local model: qwen3** (primary target the kernel is built and
   gated against), with `llama3.1-8b` as the fallback entry in the capability
   table.
4. **License: Apache-2.0** (see `LICENSE`).

Additional decisions locked 2026-07-03 with the roadmap revision (details and
derived decisions in [`V0.1_SPEC.md`](V0.1_SPEC.md)):

5. **v0.1 is the benchmark kernel.** The `fix-failing-test` benchmark is the
   official v0.1 exit criteria; the fundamental risk (local multi-step native
   tool calling to a verifiable outcome) is proven before any downstream
   engineering.
6. **Benchmark model pin: `qwen3:14b` is the required pass** (refines
   decision 3); comparison models (`qwen3:8b`, coding-tuned models) are
   optional and non-blocking.
7. **Benchmark scoring: ≥ 4 of 5 runs pass**, seeds 1–5; the 5-run pass rate
   is the standing regression metric for every subsequent phase.
8. **Fixture stack: TypeScript + vitest** (house style), hermetic via a frozen
   lockfile and a once-per-machine cached install.
9. **`V0.1_SPEC.md` is FROZEN (2026-07-03)** as the v0.1 implementation
   contract, with three refinements folded in at freeze: benchmark-agnostic
   `BenchmarkSpec` (declarative verifiers, additive extension), rich per-run
   regression metrics (tool calls, invalid calls, retries, tokens, wall-clock,
   iterations, failure reason), and automatic transcript-replay validation
   after every benchmark run. Further v0.1 scope changes require an explicit
   Director-approved amendment.
