import type { z } from 'zod';
import type { Clock } from '../core/inject.js';
import type { EventEmitter } from '../core/events.js';

/**
 * Tool safety classes (ARCHITECTURE.md §6). v0.1 ships 'safe' and 'mutating'
 * tools only; 'confirm' / 'forbidden-unattended' gain semantics with roles in
 * v0.3 — the field exists now so the shape never changes.
 */
export type ToolSafety = 'safe' | 'mutating' | 'confirm' | 'forbidden-unattended';

export interface ToolError {
  kind: 'validation_failed' | 'policy_denied' | 'timeout' | 'execution_failed';
  message: string;
}

export type ToolResult<Out = unknown> =
  | { ok: true; output: Out; forModel: string }
  | { ok: false; error: ToolError; forModel: string };

export interface SessionRef {
  id: string;
  role: string;
}

export interface ToolContext {
  /** Absolute root; fs tools refuse resolved paths outside it. */
  workspace: string;
  /** Write allowlist (picomatch globs, workspace-relative). Absent = workspace-wide. */
  surface?: string[] | undefined;
  /**
   * Composed cancellation signal: fires on session abort OR this execution's
   * timeout. Tools MUST honor it — long/async work aborts, sync walks bail at
   * their next boundary.
   */
  signal: AbortSignal;
  /**
   * Whether a Director is available to approve `confirm`-class actions. No
   * Director channel exists until v0.3, so this is false in v0.2 and
   * confirm / forbidden-unattended tools are denied.
   */
  attended?: boolean | undefined;
  clock: Clock;
  emitter: EventEmitter;
  session: SessionRef;
}

export interface Tool<In = unknown, Out = unknown> {
  /** snake_case, stable across versions. */
  name: string;
  /** Written for the model: when and how to use it. */
  description: string;
  inputSchema: z.ZodType<In>;
  safety: ToolSafety;
  parallelSafe: boolean;
  /** Hard cap enforced by the executor, not trusted to the tool. */
  timeoutMs: number;
  execute(input: In, ctx: ToolContext): Promise<ToolResult<Out>>;
}

export function ok<Out>(output: Out, forModel: string): ToolResult<Out> {
  return { ok: true, output, forModel };
}

export function fail(error: ToolError, forModel?: string): ToolResult<never> {
  return { ok: false, error, forModel: forModel ?? `ERROR (${error.kind}): ${error.message}` };
}
