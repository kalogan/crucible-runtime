// Every observable state transition is an event (ARCHITECTURE.md §12). The
// JSONL transcript is this stream serialized; the metrics in a RunResult are
// derived from it; replay validation reconstructs session state from it.

import type { AssistantMessage, RuntimeMessage, ToolCall, TokenUsage } from './messages.js';
import type { TurnResult } from './loop.js';

export type ToolErrorKind =
  | 'validation_failed'
  | 'unknown_tool'
  | 'policy_denied'
  | 'timeout'
  | 'execution_failed';

interface BaseEvent {
  sessionId: string;
  /** Monotonic per-session sequence number; replay checks contiguity. */
  seq: number;
  at: number;
}

export interface TurnStartedEvent extends BaseEvent {
  type: 'turn_started';
  /** Full message log at turn start (write-ahead: journaled before INFER). */
  messages: RuntimeMessage[];
}

export interface InferRequestEvent extends BaseEvent {
  type: 'infer_request';
  iteration: number;
  messageCount: number;
  model: string;
}

export interface InferResponseEvent extends BaseEvent {
  type: 'infer_response';
  message: AssistantMessage;
  usage: TokenUsage;
  stopReason: 'end' | 'tool_calls' | 'max_tokens' | 'aborted';
}

export interface ProviderRetryEvent extends BaseEvent {
  type: 'provider_retry';
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  call: ToolCall;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  message: ToolMessageShape;
  ok: boolean;
  errorKind?: ToolErrorKind | undefined;
  /** The tool's structured output (JSON-serializable) — what verifiers read. */
  output?: unknown;
  durationMs: number;
}

// Structurally identical to ToolMessage; named separately so the event schema
// is stable even if the message model grows fields.
interface ToolMessageShape {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
}

export interface PolicyDeniedEvent extends BaseEvent {
  type: 'policy_denied';
  tool: string;
  path?: string | undefined;
  reason: string;
}

export interface TurnFinishedEvent extends BaseEvent {
  type: 'turn_finished';
  result: TurnResult;
}

export interface SessionErrorEvent extends BaseEvent {
  type: 'session_error';
  message: string;
}

export type RuntimeEvent =
  | TurnStartedEvent
  | InferRequestEvent
  | InferResponseEvent
  | ProviderRetryEvent
  | ToolCallEvent
  | ToolResultEvent
  | PolicyDeniedEvent
  | TurnFinishedEvent
  | SessionErrorEvent;

/**
 * Write-ahead sink: implementations MUST persist the event durably before
 * returning (the transcript writer appends synchronously). The loop emits
 * before applying the corresponding state change.
 */
export type EventSink = (event: RuntimeEvent) => void;

/** Session-scoped emitter that stamps sessionId/seq/at so call sites can't get them wrong. */
export interface EventEmitter {
  emit(event: DistributiveOmit<RuntimeEvent, 'sessionId' | 'seq' | 'at'>): void;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export function createEmitter(
  sessionId: string,
  now: () => number,
  sink: EventSink,
): EventEmitter {
  let seq = 0;
  return {
    emit(event) {
      seq += 1;
      sink({ ...event, sessionId, seq, at: now() } as RuntimeEvent);
    },
  };
}
