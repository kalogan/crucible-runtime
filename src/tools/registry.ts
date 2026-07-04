// name → tool lookup, Zod → JSON Schema generation, and the executor
// (V0.1_SPEC.md §5.2). Failures become tool-result messages the model can
// read and react to; the executor itself never throws.

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JsonSchemaTool, ToolCall, RuntimeMessage } from '../core/messages.js';
import type { ToolErrorKind } from '../core/events.js';
import type { ToolExecutor } from '../core/loop.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

type ToolMessage = Extract<RuntimeMessage, { role: 'tool' }>;

export interface ExecutedTool {
  message: ToolMessage;
  ok: boolean;
  errorKind?: ToolErrorKind | undefined;
  output?: unknown;
  durationMs: number;
}

const TIMEOUT = Symbol('timeout');

export class ToolRegistry implements ToolExecutor {
  private readonly tools = new Map<string, Tool<never, unknown>>();
  private schemas: JsonSchemaTool[] | null = null;

  register<In, Out>(tool: Tool<In, Out>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool<never, unknown>);
    this.schemas = null;
    return this;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  jsonSchemas(): JsonSchemaTool[] {
    if (this.schemas === null) {
      this.schemas = [...this.tools.values()].map((tool) => {
        const schema = zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none' }) as Record<
          string,
          unknown
        >;
        delete schema['$schema'];
        return { name: tool.name, description: tool.description, parameters: schema };
      });
    }
    return this.schemas;
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ExecutedTool> {
    const started = ctx.clock.now();
    const done = (result: ToolResult, errorKind?: ToolErrorKind): ExecutedTool => ({
      message: {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.forModel,
      },
      ok: result.ok,
      errorKind: result.ok ? undefined : errorKind,
      output: result.ok ? result.output : undefined,
      durationMs: ctx.clock.now() - started,
    });

    const tool = this.tools.get(call.name);
    if (!tool) {
      const known = this.names().join(', ');
      return done(
        {
          ok: false,
          error: { kind: 'execution_failed', message: `unknown tool: ${call.name}` },
          forModel: `ERROR: unknown tool "${call.name}". Available tools: ${known}.`,
        },
        'unknown_tool',
      );
    }

    // Safety gate (V0.2): confirm / forbidden-unattended tools require a live
    // Director. There is no Director channel until v0.3, so an unattended
    // session denies them outright — the model reads the denial and adapts.
    if (
      (tool.safety === 'confirm' || tool.safety === 'forbidden-unattended') &&
      ctx.attended !== true
    ) {
      const reason = `${call.name} is ${tool.safety} and requires an attended session (no Director available)`;
      ctx.emitter.emit({ type: 'policy_denied', tool: call.name, reason });
      return done(
        {
          ok: false,
          error: { kind: 'policy_denied', message: reason },
          forModel: `DENIED: ${reason}. Choose a different approach that does not require Director approval.`,
        },
        'policy_denied',
      );
    }

    const parsed = tool.inputSchema.safeParse(call.arguments);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return done(
        {
          ok: false,
          error: { kind: 'validation_failed', message: detail },
          forModel: `ERROR: invalid arguments for ${call.name} — ${detail}. Fix the arguments and call again.`,
        },
        'validation_failed',
      );
    }

    // H1 — composed cancellation: the tool receives a signal that fires on
    // EITHER session abort or this execution's timeout, so a timeout actually
    // cancels the tool (run_command kills its process tree; sync tools bail at
    // their next boundary) instead of abandoning it to run on past the slot.
    // The timeout itself is driven by the injected clock (deterministic).
    const timeoutController = new AbortController();
    const sleepGuard = new AbortController();
    const composedSignal = AbortSignal.any([ctx.signal, timeoutController.signal]);
    const execCtx: ToolContext = { ...ctx, signal: composedSignal };
    try {
      const result = await Promise.race([
        tool.execute(parsed.data as never, execCtx),
        ctx.clock.sleep(tool.timeoutMs, sleepGuard.signal).then(
          () => {
            timeoutController.abort(); // cancel the tool via its composed signal
            return TIMEOUT as never;
          },
          () => TIMEOUT as never, // sleep guard aborted: the tool won the race
        ),
      ]);
      if ((result as unknown) === TIMEOUT) {
        return done(
          {
            ok: false,
            error: { kind: 'timeout', message: `${call.name} exceeded ${tool.timeoutMs}ms` },
            forModel: `ERROR: ${call.name} timed out after ${tool.timeoutMs}ms — this is a hang, not a pass.`,
          },
          'timeout',
        );
      }
      const toolResult = result as ToolResult;
      return done(toolResult, toolResult.ok ? undefined : toolResult.error.kind);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return done(
        {
          ok: false,
          error: { kind: 'execution_failed', message },
          forModel: `ERROR: ${call.name} failed — ${message}`,
        },
        'execution_failed',
      );
    } finally {
      sleepGuard.abort(); // release the pending sleep timer if the tool won
    }
  }
}
