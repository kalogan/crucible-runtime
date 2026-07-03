// The provider seam (ARCHITECTURE.md §7). This file is the ONLY provider
// module core/tools/bench may import (lint-enforced): interfaces and data
// shapes, no implementation, no SDK.

import type { AssistantMessage, JsonSchemaTool, RuntimeMessage, TokenUsage } from '../core/messages.js';

export interface ModelCapabilities {
  /** Hard requirement — false means the model is unusable in this runtime. */
  nativeTools: boolean;
  parallelToolCalls: boolean;
  /** Tokens. Drives num_ctx for Ollama; the adapter refuses to run without it. */
  contextWindow: number;
  supportsSystemPrompt: boolean;
  promptCaching: 'none' | 'prefix' | 'explicit';
  /** Hybrid-reasoning support (qwen3 'think'); undefined = not applicable. */
  thinking?: boolean | undefined;
  /** Recommended sampling for tool use; benchmark specs may override. */
  sampling?: SamplingOptions | undefined;
}

export interface SamplingOptions {
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
}

export interface ChatOptions extends SamplingOptions {
  seed?: number | undefined;
  maxTokens?: number | undefined;
  signal: AbortSignal;
}

export interface ChatRequest {
  model: string;
  messages: RuntimeMessage[];
  tools: JsonSchemaTool[];
  options: ChatOptions;
}

export interface ChatResponse {
  message: AssistantMessage;
  usage: TokenUsage;
  stopReason: 'end' | 'tool_calls' | 'max_tokens' | 'aborted';
}

export interface Provider {
  id: string;
  capabilities(model: string): ModelCapabilities;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /**
   * Environment record for reports: model digest/version where the backend
   * exposes it (Ollama /api/tags), null where it doesn't.
   */
  modelDigest?(model: string): Promise<string | null>;
}
