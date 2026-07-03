// RuntimeMessage ⇄ Ollama /api/chat wire format. All wire knowledge lives
// here; nothing upstream sees these shapes.

import type { IdGen } from '../../core/inject.js';
import type { AssistantMessage, JsonSchemaTool, RuntimeMessage, TokenUsage } from '../../core/messages.js';

export interface OllamaWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_name?: string;
}

export interface OllamaWireTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaChatResponse {
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export function toWireMessages(messages: RuntimeMessage[]): OllamaWireMessage[] {
  return messages.map((m): OllamaWireMessage => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const wire: OllamaWireMessage = { role: 'assistant', content: m.content };
        if (m.toolCalls.length > 0) {
          wire.tool_calls = m.toolCalls.map((c) => ({
            function: { name: c.name, arguments: c.arguments ?? {} },
          }));
        }
        return wire;
      }
      case 'tool':
        // Ollama's tool message carries no call id; tool_name helps the model
        // correlate and is ignored by servers that predate it.
        return { role: 'tool', content: m.content, tool_name: m.name };
    }
  });
}

export function toWireTools(tools: JsonSchemaTool[]): OllamaWireTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function fromWireResponse(
  body: OllamaChatResponse,
  ids: IdGen,
): { message: AssistantMessage; usage: TokenUsage; stopReason: 'end' | 'tool_calls' | 'max_tokens' } {
  const wire: NonNullable<OllamaChatResponse['message']> = body.message ?? { role: 'assistant' };
  const toolCalls = (wire.tool_calls ?? [])
    .filter((c) => typeof c.function?.name === 'string' && c.function.name.length > 0)
    .map((c) => ({
      // Ollama supplies no call id — mint one (normalized model requires it).
      id: ids.next('call'),
      name: c.function!.name!,
      // Already a parsed object on this wire; guard against a string anyway.
      arguments: typeof c.function!.arguments === 'string'
        ? safeParseJson(c.function!.arguments as string)
        : (c.function!.arguments ?? {}),
    }));

  const message: AssistantMessage = {
    role: 'assistant',
    content: wire.content ?? '',
    toolCalls,
  };
  const usage: TokenUsage = {
    inputTokens: body.prompt_eval_count ?? 0,
    outputTokens: body.eval_count ?? 0,
  };
  const stopReason =
    toolCalls.length > 0 ? 'tool_calls' : body.done_reason === 'length' ? 'max_tokens' : 'end';
  return { message, usage, stopReason };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}
