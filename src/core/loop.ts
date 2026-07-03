// The turn state machine: ASSEMBLE → INFER → EXECUTE (V0.1_SPEC.md §5.1).
// v0.1 assembly is naive full history — the context ledger arrives in v0.4.
// Tool failures return to the model as tool-result messages; only
// infrastructure failures end the turn.

import type { Clock } from './inject.js';
import type { EventEmitter, ToolErrorKind } from './events.js';
import type { JsonSchemaTool, RuntimeMessage, ToolCall, TokenUsage } from './messages.js';
import { addUsage } from './messages.js';
import type { Provider, ChatOptions } from '../providers/types.js';
import type { ToolContext } from '../tools/types.js';
import { isAbortError } from './errors.js';

export type TurnOutcome =
  | 'completed'
  | 'max_iterations'
  | 'budget_exceeded'
  | 'aborted'
  | 'provider_failed'
  | 'context_overflow';

/**
 * The Ring-3 integrity guard (NOT the v0.4 context manager): when the
 * provider reports a prompt at/over this fraction of the model's window, the
 * turn fails loudly instead of continuing on a silently truncated context —
 * a benchmark must never measure a model that has lost its system prompt.
 */
export const CONTEXT_OVERFLOW_THRESHOLD = 0.9;

export interface TurnResult {
  outcome: TurnOutcome;
  /** The assistant's final text (its report); empty unless outcome is 'completed'. */
  finalText: string;
  iterations: number;
  usage: TokenUsage;
}

export interface Budgets {
  maxIterations: number;
  wallClockMs: number;
}

/** What the loop needs from the tool layer — implemented by ToolRegistry. */
export interface ToolExecutor {
  jsonSchemas(): JsonSchemaTool[];
  execute(
    call: ToolCall,
    ctx: ToolContext,
  ): Promise<{
    message: Extract<RuntimeMessage, { role: 'tool' }>;
    ok: boolean;
    errorKind?: ToolErrorKind | undefined;
    output?: unknown;
    durationMs: number;
  }>;
}

export interface LoopDeps {
  provider: Provider;
  model: string;
  /** The model's context window (tokens); drives the overflow guard. */
  contextWindow: number;
  chatOptions: Omit<ChatOptions, 'signal'>;
  /** Owned by the session; the loop appends in place. */
  messages: RuntimeMessage[];
  tools: ToolExecutor;
  toolContext: ToolContext;
  budgets: Budgets;
  signal: AbortSignal;
  emitter: EventEmitter;
  clock: Clock;
}

export async function runTurn(deps: LoopDeps): Promise<TurnResult> {
  const { messages, emitter, clock, budgets } = deps;
  const startedAt = clock.now();
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let iterations = 0;

  emitter.emit({ type: 'turn_started', messages: structuredClone(messages) });

  const finish = (outcome: TurnResult['outcome'], finalText = ''): TurnResult => {
    const result: TurnResult = { outcome, finalText, iterations, usage };
    emitter.emit({ type: 'turn_finished', result });
    return result;
  };

  for (;;) {
    if (deps.signal.aborted) return finish('aborted');
    if (iterations >= budgets.maxIterations) return finish('max_iterations');
    if (clock.now() - startedAt >= budgets.wallClockMs) return finish('budget_exceeded');

    iterations += 1;
    emitter.emit({
      type: 'infer_request',
      iteration: iterations,
      messageCount: messages.length,
      model: deps.model,
    });

    let response;
    try {
      response = await deps.provider.chat({
        model: deps.model,
        messages,
        tools: deps.tools.jsonSchemas(),
        options: { ...deps.chatOptions, signal: deps.signal },
      });
    } catch (err) {
      if (isAbortError(err)) return finish('aborted');
      emitter.emit({
        type: 'session_error',
        message: err instanceof Error ? err.message : String(err),
      });
      return finish('provider_failed');
    }

    // Write-ahead: journal the response before it becomes state.
    emitter.emit({
      type: 'infer_response',
      message: response.message,
      usage: response.usage,
      stopReason: response.stopReason,
    });
    messages.push(response.message);
    usage = addUsage(usage, response.usage);

    // Authoritative overflow check: prompt_eval_count is the prompt as the
    // model actually saw it. At/near the window it either just truncated or
    // will on the next iteration — fail loudly either way. (Ollama truncates
    // from the front, evicting the system prompt first, and never errors.)
    const overflowAt = Math.floor(deps.contextWindow * CONTEXT_OVERFLOW_THRESHOLD);
    if (response.usage.inputTokens >= overflowAt) {
      emitter.emit({
        type: 'session_error',
        message:
          `context overflow: prompt used ${response.usage.inputTokens} of ` +
          `${deps.contextWindow} tokens (guard threshold ${overflowAt})`,
      });
      return finish('context_overflow');
    }

    if (response.message.toolCalls.length === 0) {
      return finish('completed', response.message.content);
    }

    // v0.1 executes sequentially (parallel execution is v0.2); results are
    // appended in call order either way.
    for (const call of response.message.toolCalls) {
      emitter.emit({ type: 'tool_call', call });
      const executed = await deps.tools.execute(call, deps.toolContext);
      emitter.emit({
        type: 'tool_result',
        message: executed.message,
        ok: executed.ok,
        errorKind: executed.errorKind,
        output: executed.output,
        durationMs: executed.durationMs,
      });
      messages.push(executed.message);
    }
  }
}
