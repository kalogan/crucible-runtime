# The Architect–Builder Pipeline

*A methodology for delivering high-quality software with AI agents — fast, in
parallel, and while the human is mostly AFK, without lowering the quality bar.*

> **Audience:** this document is written for **both humans and machines.**
> Humans read the prose to understand *why* the pipeline works and *when* to use
> it. An orchestrating agent (e.g. a "lead" model supervising worker models) can
> follow the **recipes, templates, and decision tables** in
> [Part II](#part-ii--for-the-orchestrating-agent-machine-readable) directly.
>
> It is deliberately **project-agnostic.** A concrete worked example (the
> *Wayfinders* MMORPG it was developed on) lives in the
> [Appendix](#appendix--worked-example-wayfinders).

---

## TL;DR

One human sets direction and judges quality. One **Architect** agent plans,
interrogates, decomposes, dispatches, supervises, and *independently verifies*.
Many **Builder** agents do focused, disjoint slices of work in parallel. Nothing
a builder claims is trusted until the Architect re-runs the full gate with real
exit codes. Work is checkpointed constantly so nothing is ever lost. The human
is consulted only for the things only a human can decide — design forks, feel,
and risky/irreversible actions — which is what makes being AFK safe.

The result: **massive parallel progress at a high, enforced quality bar, with the
human in the loop only where their judgment is irreplaceable.**

---

## Part I — For humans

### 1. The core idea

Most "AI builds my app" workflows fail one of two ways:

1. **Trust collapse.** The agent says "done, all tests pass," but they don't, and
   nobody checked. Quality rots silently.
2. **Human bottleneck.** The human has to babysit every step, so throughput is
   capped at human attention and there's no real leverage.

This pipeline fixes both by borrowing one idea from distributed systems:

> **The Architect is authoritative. Everything a Builder reports is *untrusted
> input* until independently verified.**

(If that sounds familiar, it's the same "server authoritative, client is
optimistic-cosmetic" rule that good multiplayer games use. Builders are the
optimistic clients; the Architect is the authoritative server; the gate is the
validation step. Never trust a client-reported "I scored a hit." Never trust a
builder-reported "all green.")

Around that one rule, everything else falls into place: you can run many builders
at once (they're untrusted anyway, so verification is uniform), you can leave them
unattended (the supervisor catches stalls and the gate catches lies), and you can
keep the quality bar high (it's encoded as constraints + an automated gate, not as
vigilance).

### 2. The three roles

| Role | Who | Owns | Never does |
|---|---|---|---|
| **Director** | The human | Direction, design authority, feel/taste, approvals, risk calls | Babysitting; writing the bulk of the code |
| **Architect** | One "lead" agent (a strong reasoning model) | Planning, grilling, decomposition, dispatch, supervision, **independent verification**, recovery, documentation | Trusting a builder's self-report; doing risky/irreversible actions unattended |
| **Builder** | Many "worker" agents (capable coding models), run in background | One disjoint, well-scoped slice each, to a defined gate | Touching another builder's files; destructive git; broad commits |

The leverage comes from the **fan-out**: one Director, one Architect, *N* Builders.
The Director spends minutes; the Architect spends the coordination effort once and
amortizes it across many parallel builders; the Builders do the volume.

### 3. The loop

```
        ┌─────────────────────────────────────────────────────────┐
        │                      DIRECTOR (human)                     │
        │   sets intent · answers grills · judges feel · approves   │
        └───────────────▲───────────────────────────┬─────────────┘
                        │ surfaces only              │ intent
                        │ what needs judgment        ▼
        ┌───────────────┴───────────────────────────────────────────┐
        │                        ARCHITECT                           │
        │                                                            │
        │   1. GRILL    lock the design before building anything     │
        │   2. PLAN     decompose into disjoint, sequenced slices    │
        │   3. DISPATCH launch builders (scoped + constrained + gate)│
        │   4. SUPERVISE health-check loop: liveness, stalls, deaths │
        │   5. VERIFY   re-run the FULL gate with REAL exit codes    │
        │   6. RECOVER  salvage → relaunch; fix small failures       │
        │   7. PERSIST  update memory/roadmap; queue review items     │
        │   8. ADVANCE  report + move to next slice (or stop-before)  │
        └───────────────┬───────────────────────────────────────────┘
                        │ disjoint slices              ▲ untrusted reports
                        ▼                              │ (verified, never trusted)
        ┌───────────────────────────────────────────────────────────┐
        │   BUILDER   BUILDER   BUILDER   …   (parallel, background)  │
        └───────────────────────────────────────────────────────────┘
```

The eight steps are not strictly linear — supervision (4) runs continuously while
builders work, and grill→plan→dispatch can pipeline (you grill the *next* slice
while the *current* one builds). But every slice passes through all eight.

### 4. The eight steps, explained

#### 1. Grill — lock the design before writing code
Before building anything non-trivial, **interrogate the Director** until the design
is unambiguous. Ambiguity compounds: a wrong assumption at design time becomes a
wasted parallel fan-out. Force the key forks into explicit, mutually-exclusive
choices and ask them as **structured questions** (2–4 at a time, each with crisp
options and trade-offs). The Director answers in a minute; you build on rock.

> **Heuristic:** if you can't write the builder's task without guessing, you
> haven't grilled enough. Each unanswered fork is a question you owe the Director.

#### 2. Plan — decompose into disjoint, sequenced slices
Break the work into slices that are:
- **Disjoint by file surface** — two slices that never touch the same files can run
  in parallel safely. This is the single most important property for fan-out.
- **Dependency-ordered** — if B builds on A, sequence them; don't fan out a chain.
- **Gate-able** — each slice has a concrete, automated definition of done.

Phase large features (e.g. a new subsystem) into a *sequence* of slices, each
shippable and green on its own, rather than one giant slice.

#### 3. Dispatch — launch builders with everything they need to succeed alone
A builder runs **in the background** with no further conversation. So the dispatch
prompt must be self-contained and carry five things (template in
[Part II](#a-builder-dispatch-prompt-template)):
1. **Scope** — exactly what to build and the file surface to stay within.
2. **Context** — what already exists, what to read first, what *not* to redo.
3. **Constraints** — the non-negotiable quality/architecture rules (§5).
4. **Git + safety discipline** — targeted commits only, **committed incrementally
   (one per layer/file, before the final gate)**, no destructive ops, no touching
   other builders' surfaces, no risky/irreversible/external actions.
5. **The gate** — the exact commands that define "done," run with real exit codes
   and **each under a hard timeout** (a hung gate must fail fast, not block forever),
   with the instruction to **stop and report rather than commit red.**

#### 4. Supervise — the health-check loop that makes AFK safe
While builders work, the Architect runs a **self-paced supervision loop**: wake
periodically, check each builder's liveness, detect stalls and deaths, and recover.
This is what lets the Director walk away. Key mechanics:
- **Liveness = file-staleness + new commits. Nothing else.** The only trustworthy
  signals are (a) the modification time of the **source files in the builder's
  surface** and (b) new commits attributable to it. **Do NOT trust process counts**
  ("`node` is running, so it's alive") and **do NOT trust a dirty working tree** —
  both lie (see the next two bullets). Don't read the agent's own transcript/output
  file either: it overflows context, and its mtime tracks chatter, not progress.
- **Absolute stall/death test:** *newest source mtime in the builder's surface is
  stale beyond a threshold (~15 min)* **AND** *no new commit from it in that window*
  → treat as **dead**: salvage and relaunch — **regardless of how many processes are
  running.**
- **The zombie-gate trap (written in blood).** A builder that finishes its work then
  runs a gate (`test`/`build`) can hang *forever* if the gate never exits — a common
  cause is a test runner that won't terminate because a server/socket/DB/timer handle
  was left open (the tests *pass*, the process just never quits). The hung gate
  leaves orphaned `node` processes that look exactly like active work. A supervisor
  that reads "processes present = alive" will babysit a corpse. We lost ~67 minutes
  this way before switching to mtime+commits only. Prevent it at the source with gate
  timeouts and commit-per-layer (§4-prevention below).
- **Don't wait for the completion signal.** A hung or crashed builder never sends
  one. The loop must *proactively* check mtime+commits **every** wake, not sit idle
  waiting to be told a builder finished.
- **A dirty tree is not "alive."** Uncommitted changes that aren't advancing are
  stalled work, not progress. (On Windows with `autocrlf`, files can even show as
  modified purely from line-ending normalization — *phantom dirt*. Confirm real
  change with a diff that ignores EOL, e.g. `git diff --ignore-cr-at-eol`, before
  reading anything into a dirty status.)
- **Death/limit detection:** a builder can also hit a session/usage limit or crash
  outright. Same response: salvage, relaunch.
- **Keep the supervisor itself alive.** If the loop is session-bound and the host
  machine can sleep, you'll get silent multi-hour gaps. Run a keep-awake guard
  during AFK windows. *(Also written in blood — see Appendix.)*

**§4-prevention — design builders that fail safe.** A hang or crash shouldn't cost
the work *or* the wall-clock. Two rules, enforced at dispatch (and a third in the
test suite):
- **Commit per layer, before the final gate.** Each finished file/layer is its own
  commit, so a hang loses at most the last increment — never the whole task. The
  anti-pattern that bit us: do everything, commit once at the end → a hang right
  before that commit risks *all* of it.
- **Timeout every long command.** Wrap gates in a hard timeout (`timeout 600 <test>`,
  `timeout 300 <build>`). This converts an infinite block into a fast, recoverable
  failure (a timeout exit code = "investigate the hang," not "passed").
- **Make tests exit cleanly.** Close every server/socket/DB handle in teardown and
  set per-test/hook/teardown timeouts in the runner config, so the *runner* aborts a
  stuck case instead of wedging the whole run.

#### 5. Verify — independent gating with REAL exit codes
**This is the heart of the pipeline.** When a builder reports "done, all green," the
Architect **re-runs the full gate itself** and reads the **actual exit codes** — it
does not trust the prose. A "balanced hard-gate" is fast, deterministic, and
blocking:
- typecheck · lint + architecture guards · unit tests (record the **counts**) ·
  schema/migration golden fixtures · content/data lint · build.

Trust nothing claimed; verify everything. Record the test counts every time so a
silent drop (tests that vanished rather than passed) is visible. (Recipe and the
real-exit-code trap in [Part II](#b-the-gate-real-exit-codes).)

#### 6. Recover — salvage, then relaunch; fix small things inline
- **Small gate failure** (a lint nit, a one-line type error, a missing export): the
  Architect fixes it directly. Don't round-trip a builder for a typo.
- **Stall or death:** **salvage first** — commit the builder's uncommitted work as a
  `wip(...)` checkpoint so nothing is lost — **then relaunch** a *continuation*
  builder that picks up from that checkpoint. Never `reset --hard` away work.
- **Coordination mess** (one builder's broad commit swept another's files): detect
  it (verify each commit's file list), and correct without rewriting shared history
  while a parallel builder is live.

#### 7. Persist — write down state, queue what needs human eyes
After each slice: update the durable **status/memory** (what's done, what's running,
what's queued), mark **roadmap** progress, and append anything that needs the
Director's *taste* (visual look, game feel, wording) to a **review queue** rather
than blocking on it. Pattern: **write → persist → notify.**

#### 8. Advance — report, then move (or stop-before)
Report to the Director in their terms: *what landed, how to try it, what's next.*
Then either advance to the next queued slice autonomously, or — for anything past a
predefined **safety boundary** — stop and ask. Autonomy is the default; the
boundaries (§8) are the exceptions.

### 5. The quality bar is the constraints

The bar isn't enforced by vigilance — it's encoded as a short list of
**non-negotiable constraints** handed to *every* builder, and checked by the gate.
Make them few, explicit, and testable. Examples of the *kinds* of rules that belong
here (yours will differ):
- Architectural boundaries ("module X may not import Y") — enforced by an automated
  guard, not by hope.
- "The authoritative source is the server/core; clients are optimistic-cosmetic."
- "Everything persisted is versioned and migrates forward; ship a golden fixture
  with every schema change."
- "Deterministic core: inject the clock and RNG; never call wall-clock or random
  directly."
- "Every new system ships with tests."

If a rule matters, it goes in this list *and* in the gate. A rule that isn't
gated will be violated.

### 5b. The four dimensions — what the gate can and can't verify

A useful lens for *what quality even means*: judge every change on four axes —
**Functional** (does it do what it should?), **Craft** (how well?), **Contextual**
(does it work in the real system?), and **PMF** (does it add value?). The automated
gate is strongest at the bottom of the stack and thins out toward the top:

| Dimension | Gate coverage | The gap |
|---|---|---|
| **Functional** | High for deterministic core logic; low for the *running, assembled* app | rendering, client prediction, cross-system flows — **tests pass while the visible thing is wrong** |
| **Craft** | Mechanical (types, lint, arch-guards, test counts) | design, perf, duplication, *test depth* — on trust |
| **Contextual** | Server-integration paths | full stack live (real DB/browser/GPU/latency/scale) + the *actual running instance* (stale-build masquerading as a bug) |
| **PMF** | None (by nature) | fun / wanted / retained — needs real users |

The consequence to internalize: **without extra layers, the human becomes the test
harness for the top three-quarters of the stack** — every playtest is them running
the checks the gate can't, which is both the throughput bottleneck and the risk.
Two cheap layers claw back the most painful gaps:

- **Lightweight runtime smoke (Architect-run).** After a *visible* slice clears the
  logic gate, the Architect boots the **freshly-built** app — or the **client-only
  preview tool** for content/visual slices — drives the key screens, screenshots,
  and scans the console/network. This is the **single highest-value add above the
  logic gate**: it catches the "green-but-broken" and "stale-build" classes before
  the human ever sees them. (Boot on alt ports; never disturb the human's running
  instances. If a clean boot isn't possible, say so — don't fake a green.)
- **Adversarial code review on risky/large slices.** Schema changes,
  server-authority/security code, and large slices get a diff-level review (design,
  perf, subtle bugs the lint+tests miss). Small/cosmetic slices skip it to keep
  throughput.

**PMF stays a human call.** No gate can answer it — so name it explicitly as a
standing risk (you can build beautifully-verified things nobody wants) and decide
*deliberately* whether to seek real-user signal or keep building on conviction.
Never let the green gate masquerade as product validation.

### 6. Why the parallelism is safe

Two builders can run at once **iff their file surfaces are disjoint.** That's the
whole trick. The Architect guarantees disjointness at plan time and re-checks it at
dispatch. The remaining hazard is *git coordination* — a careless `git add .` in one
builder sweeping another's files — so the discipline is **targeted adds only** and
**verify every commit's file list** during supervision.

### 7. Cost-awareness (cadence)

Supervision has a cost. Two practical levers:
- **Don't poll work the harness will notify you about.** If completion triggers a
  notification, set a long *fallback* heartbeat, not a tight poll.
- **Respect cache windows.** Many agent runtimes cache context for a few minutes;
  waking just past that window pays a full cache miss for nothing. Either stay
  inside the window (short, frequent, cheap) or commit to a genuinely long wait
  (amortize one miss over a long sleep). Avoid the worst-of-both middle.

### 8. Safety boundaries (what the Architect never does unattended)

Autonomy is bounded. Define, up front, the actions that **always** require the
Director — and never cross them while AFK:
- **Destructive/irreversible:** hard resets that discard work, force-pushes,
  deleting data, dropping tables.
- **External/side-effectful:** deploys needing real credentials, sending real
  messages/emails, publishing, spending money, anything touching production.
- **Designated risky features:** specific milestones the Director flagged as
  "stop and check with me first" (e.g. a security-sensitive or
  hard-to-reverse subsystem).
- **Trust actions:** modifying access controls, secrets, or auth.

Everything else is fair game unattended. When in doubt, **checkpoint and ask**
rather than act.

---

## Part II — For the orchestrating agent (machine-readable)

This part is written so an Architect agent can execute the pipeline directly. The
commands assume a JS/TS monorepo; adapt the specifics, keep the structure.

### A. Builder dispatch prompt template

Fill every `<…>`. Launch in the background. One slice per builder.

```
You are building ONE focused slice of <PROJECT>. Repo: <ABS PATH> (<stack>).
Branch: <work-branch> (commit ONLY here; <main-branch> stays clean).

SCOPE: <exactly what to build>.
STAY WITHIN THIS FILE SURFACE: <dirs/files>. Do NOT touch anything else.

CONTEXT — read first, do NOT redo:
- <already-built things / files to read to understand the seams>
- <what exists that you must reuse, not reinvent>

CONSTRAINTS (non-negotiable; also checked by the gate):
- <constraint 1>  e.g. core stays engine-agnostic / no forbidden imports
- <constraint 2>  e.g. server/source-of-truth authoritative
- <constraint 3>  e.g. deterministic: inject clock+RNG, no wallclock/random
- <constraint 4>  e.g. version everything + ship a golden fixture on schema change
- <constraint 5>  e.g. every new system ships tests

GIT + SAFETY DISCIPLINE:
- ⚠️ TARGETED git add ONLY — `git add <each specific file>`. NEVER `git add -A`,
  `git add .`, or `git add <dir>`. Other builders run in parallel on other
  surfaces; a broad add will SWEEP their files into your commit. Verify
  `git status` before every add.
- NO `git reset --hard`. NO force-push. NO history rewrite (a parallel builder is live).
- COMMIT PER LAYER, AS YOU GO — one commit per file/layer the moment it's done,
  BEFORE the final gate. Do NOT batch all the work into one end-of-task commit (if
  anything hangs before it, the whole task is lost). Clear messages + the project's
  Co-Authored-By trailer.
- No destructive/irreversible/external actions. No deploys. No background dev server
  (use the test harness). Do not kill the human's running processes/ports.

THE GATE (run with REAL exit codes, EACH UNDER A HARD TIMEOUT; do NOT trust a glance):
- timeout <N> <typecheck cmd>      → exit 0
- timeout <N> <lint + arch-guards> → exit 0   AND  <content/data lint> → exit 0
- timeout <N> <unit tests>         → exit 0   (report per-package COUNTS)
- timeout <N> <golden/migration>   → exit 0
- timeout <N> <build>              → exit 0
A timeout (e.g. exit 124) means the command HUNG — do NOT treat as pass; report it
and investigate the open-handle/non-exiting-process cause. If you CANNOT reach green,
STOP and report the blocker. Do NOT commit red.

REPORT: what you built, key decisions, anything needing human taste
(look/feel/wording), and the EXACT gate exit codes + test counts.
```

### B. The gate (real exit codes)

The classic trap: a pipe (`cmd | tee log`) reports the **pipe's** exit code, not the
command's, so a failing step looks green. Capture the real code.

```bash
# bash — capture the actual command's exit code, not the pipe's
set +e
timeout 300 pnpm -r typecheck            ; tc=$?
timeout 180 pnpm lint                    ; ln=$?
timeout 180 pnpm lint:content            ; lc=$?
timeout 600 pnpm -r test 2>&1 | tee /tmp/test.log ; tst=${PIPESTATUS[0]}   # ← real code, hard-capped
timeout 300 pnpm -r build                ; bd=$?
echo "typecheck=$tc lint=$ln content=$lc test=$tst build=$bd"
# ALL must be 0. Exit 124 = the command HUNG (e.g. a non-exiting test process) — a
# failure to investigate, NOT a pass. Then extract + RECORD the per-package test counts.
```

Rules for the verifying Architect:
- **Never** trust a builder's "all green." Re-run this yourself.
- **Always** run lint *and* content/data lint — they're the easiest to skip and the
  cheapest to catch.
- **Record the counts** each run. A drop from 673→640 with everything "green" means
  tests were deleted or skipped, not passing.
- A parallel builder may leave the tree transiently red on a *different* surface
  (a symbol mid-add). Distinguish "my slice is broken" from "someone else's in-flight
  edit" by filtering the failing package and re-checking just your surface.
- **Cap every command with `timeout`.** The runner can hang (a test process that
  never exits because a server/socket/DB handle was left open), which would otherwise
  block the verify step forever. A timeout turns a hang into a fast, visible failure.
- **Know your flaky tests.** Track any test that fails only under full-suite/parallel
  load. If *only* that one fails, re-run it in isolation to confirm it's flake, not a
  regression — don't let a known flake block the advance, and don't chase it as a bug.

### C. Supervision check (run each wake)

```bash
git log --oneline -8          # new commits since last wake? whose? correct file list?
git status --short            # uncommitted work present? on the expected surface?
git diff --ignore-cr-at-eol --stat   # empty here = the "dirty" files are EOL-only phantom dirt
# liveness per builder = NEWEST SOURCE-FILE mtime in its surface + new commits.
# Stat the builder's dirs (e.g. PowerShell: Get-ChildItem -Recurse <surface> |
#   sort LastWriteTime -Desc | select -First 1).  Do NOT read the agent's
#   transcript/output file (overflows context) and do NOT count processes
#   (a hung gate leaves zombie `node` procs that masquerade as alive — see §D).
```

Then apply the **stall test** and act.

### D. Stall / death heuristic (decision table)

Liveness is **source-file mtime + commits only.** Ignore process count and a
static-but-dirty tree — both can read "alive" for a worker that is actually dead
(a hung gate keeps zombie `node` processes *and* leaves uncommitted work sitting
still). A real gate finishes in minutes, not tens of minutes.

| newest source mtime (in surface) | new commit this window? | → verdict | action |
|---|---|---|---|
| fresh (< ~12–15 min) | — | **alive** | leave it |
| stale | yes, recent | **alive** (committing) | leave it |
| **stale > ~15 min** | **no** | **DEAD / STALLED** | salvage → relaunch — *even if `node` processes are running* |
| reported limit / crash | — | **DEAD** | salvage → relaunch |

**Salvage → relaunch:**
```bash
git add <only the builder's expected files>
git commit -m "wip(<area>): <what> (stall/limit recovery checkpoint)
KNOWN-RED: may be partial; continuation completes + greens.
<Co-Authored-By trailer>"
```
Then launch a **continuation builder** (template A) whose CONTEXT states: what's
already committed, the wip checkpoint and what it contains, and the exact remaining
work + any known-red error to fix.

### E. Grill pattern (lock design before building)

When a request has open design forks, do **not** start building. Identify the 2–4
decisions that most change the implementation, and ask them as structured,
mutually-exclusive choices with trade-offs. Examples of high-leverage forks:
core mechanic, data/movement model, fail-state/UX, generation/authoring approach,
build-vs-reuse. Phrase options so the *consequence* of each is visible. Then
synthesize the answers into the plan and dispatch — don't re-ask what's settled.

### F. Cadence (cost-aware self-pacing)

- If completion **notifies** you, schedule a **long fallback heartbeat** (≈20–30 min)
  and let notifications drive the real cadence. Don't tight-poll notified work.
- If you must poll external state the harness can't see (CI, a deploy), match the
  delay to how fast that state changes, and stay inside the context-cache window
  (short) rather than just past it.
- Don't pick the worst-of-both middle (just past the cache TTL): either stay short
  and cheap, or go long and amortize the miss.

### G. Persistence (write → persist → notify)

- **Durable status/memory:** what's done, what's running (with IDs), what's queued,
  the last known-green gate counts, and the active constraints. Update it every slice
  so a fresh context (or a different agent) can resume cold.
- **Review queue:** append anything needing human taste (look/feel/wording) instead
  of blocking. The Director drains it on their schedule.
- **Roadmap:** mark slices done; keep the next-up ordering explicit.

---

## When to use this (and when not)

**Use it when:** the work decomposes into many disjoint slices; quality must stay
high without constant human attention; the human's time is the scarce resource; and
the work is mostly reversible (or the irreversible bits can be fenced behind §8).

**Don't bother when:** the task is a single small change (just do it); the work is
inherently serial and tiny (no fan-out to gain); or every step needs human judgment
(then it's pairing, not orchestration).

## Adapting to another project

1. Write your **non-negotiable constraints** (§5) — few, explicit, testable.
2. Define your **balanced hard-gate** (§B) — the fast deterministic commands that
   block "done," and make sure each is *gated*, not just hoped-for.
3. Pick your **work branch** and the targeted-commit discipline.
4. Identify your **safety boundaries** (§8) — the stop-and-ask list.
5. Set up **durable status/memory + a review queue** (§G).
6. Run the loop: grill → plan → dispatch (disjoint) → supervise → verify →
   recover → persist → advance.

## Glossary

- **Director** — the human; sets direction and judges taste/feel; approves risk.
- **Architect** — the lead agent; plans, dispatches, supervises, and *verifies*.
- **Builder** — a background worker agent doing one disjoint slice.
- **Slice** — a unit of work with a disjoint file surface and its own gate.
- **Gate** — the deterministic command set that defines "done"; run with real exit
  codes by the Architect, never trusted from a builder.
- **Disjoint surface** — file sets that don't overlap, so builders can run in
  parallel safely.
- **Salvage → relaunch** — checkpoint a stalled/dead builder's work as `wip`, then
  start a continuation from it.
- **Stop-before** — a safety boundary the Architect won't cross unattended.
- **Review queue** — a list of taste/feel/wording items surfaced to the Director
  instead of blocking.

---

## Appendix — worked example (*Wayfinders*)

*Wayfinders* is a browser-scale cozy MMORPG built with this pipeline. The Director
(solo dev) playtests and sets direction; the Architect (a strong reasoning model)
orchestrates; Builder agents (capable coding models) run in the background. Real
moments that shaped the rules above:

- **Independent verification caught "green" that wasn't.** Builders reported all
  tests passing; the Architect's own gate run (with `${PIPESTATUS[0]}`) repeatedly
  surfaced lint/content-lint/typecheck failures the prose had glossed. Hence:
  *re-run the gate, read real exit codes, record counts.* (A clean unified gate here
  is ~673 tests across five packages; recording the count makes a silent drop
  visible.)
- **The 6-hour AFK gap → keep-awake guard.** A session-bound supervision loop went
  silent for hours because the host slept. Fix: a keep-awake guard during AFK
  windows + absolute stall thresholds. Hence §4's "keep the supervisor itself alive."
- **Broad-add sweeps → targeted adds only.** A builder's `git add .` swept a parallel
  builder's audio files into an unrelated i18n commit (twice). Work survived, but
  attribution was a mess. Hence the hard "targeted add only + verify each commit's
  file list" rule.
- **Session-limit mid-work → salvage-then-relaunch.** A localization builder hit its
  usage limit ~75% done, leaving 7 components partially edited and one missing
  export. The Architect committed the partial work as a `wip(i18n)` checkpoint and
  launched a continuation to finish + green it — no work lost.
- **The 67-minute zombie-gate hang → liveness = mtime + commits only.** A builder
  finished a feature — complete *and* green — then its final test run hung without
  exiting, leaving orphaned `node` processes. The supervisor's heuristic counted
  those processes as "alive" and babysat the dead worker for over an hour before the
  Director noticed. Two fixes: (1) liveness now keys on file-staleness + commits,
  **never** process count or a static dirty tree; (2) every gate command runs under a
  hard **timeout** so a hung gate fails fast. The salvaged work was 100% complete —
  proving a builder can *finish yet hang before committing*, which is exactly why
  **commit-per-layer** matters: had it committed each layer, nothing would have been
  at risk regardless of the hang.
- **Why gates hang (and how to stop it).** The usual culprit is a test runner that
  won't terminate because a server/socket/DB handle (or timer) was left open — the
  tests pass, the process just never exits. The Director's *own* running copy of the
  app makes it likelier (held ports, memory contention, OS file locks). Prevention:
  clean test teardown (close every server/handle), per-test/hook/teardown timeouts in
  the test config, and the command-level `timeout` as the backstop.
- **Phantom dirt on Windows.** With git `autocrlf`, files routinely show as modified
  from line-ending normalization alone. A `git status` "dirty" worktree therefore is
  *not* evidence of live work; confirm with `git diff --ignore-cr-at-eol` before
  treating it as either progress or salvageable change.
- **Stale-server vs real bug.** Many "bugs" the Director reported were an old running
  server, not the code. Hence: when a report doesn't match the source, disambiguate
  (restart/refresh) before chasing a ghost.
- **Grilling before a big build.** For a new "flooded catacombs" biome (a deliberate
  stress-test of the content pipeline), the Architect grilled the Director on four
  forks — setting, movement model, survival mechanic + cozy fail-state, and
  generation approach — *before* any code, then phased the build (swim → oxygen →
  generator → content) into sequenced slices.
- **Cozy design rules as constraints.** Director taste ("exposure should slow, not
  kill"; "PvP opt-in only") became standing constraints handed to every relevant
  builder — taste encoded as rules, not re-litigated per slice.

The throughput this enabled: while the Director was AFK or away on a usage reset,
disjoint builders delivered a gear loop, procedural audio + music, telegraphs,
recall, a procedural boss, settings/menus, collision, localization, and more — each
independently gated to green before the next advanced.
