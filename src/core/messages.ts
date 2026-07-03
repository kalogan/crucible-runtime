// The runtime's normalized message model (ARCHITECTURE.md §7). Provider
// adapters translate to/from wire formats at their boundary; nothing upstream
// of providers/ knows what Ollama or Anthropic messages look like.

export interface ToolCall {
  /** Stable id; adapters mint one when the provider doesn't supply it. */
  id: string;
  name: string;
  /** Always a parsed object at this layer, never a JSON string. */
  arguments: unknown;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
}

export type RuntimeMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * Provider-facing tool declaration: plain JSON Schema, generated once from a
 * tool's Zod schema by the registry. Providers never see Zod.
 */
export interface JsonSchemaTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
