// Model capability registry — data, not detection (V0.1_SPEC.md §5.4).
// Ollama has no reliable "supports tools?" API; requesting tools from a
// non-tool model must fail loud at session start, not confusingly mid-turn.

import type { ModelCapabilities } from '../types.js';

// num_ctx is set from contextWindow. Ollama's silent default (often 2–8k)
// truncates agent contexts — the #1 local-model footgun; the adapter refuses
// to run a model with no capability entry.
export const OLLAMA_MODELS: Record<string, ModelCapabilities> = {
  // The v0.1 benchmark reference (Director decision): required pass.
  'qwen3:14b': {
    nativeTools: true,
    parallelToolCalls: true,
    contextWindow: 16_384,
    supportsSystemPrompt: true,
    promptCaching: 'prefix',
    thinking: true,
    // Qwen3's recommended thinking-mode sampling.
    sampling: { temperature: 0.6, topP: 0.95, topK: 20 },
  },
  // Optional comparison model (non-blocking).
  'qwen3:8b': {
    nativeTools: true,
    parallelToolCalls: true,
    contextWindow: 16_384,
    supportsSystemPrompt: true,
    promptCaching: 'prefix',
    thinking: true,
    sampling: { temperature: 0.6, topP: 0.95, topK: 20 },
  },
  // Fallback entry (Director decision #3).
  'llama3.1:8b': {
    nativeTools: true,
    parallelToolCalls: false,
    contextWindow: 16_384,
    supportsSystemPrompt: true,
    promptCaching: 'prefix',
    thinking: false,
  },
};

export function lookupCapabilities(
  model: string,
  overrides?: Record<string, Partial<ModelCapabilities>>,
): ModelCapabilities | undefined {
  const base = OLLAMA_MODELS[model];
  const override = overrides?.[model];
  if (base === undefined && override === undefined) return undefined;
  const merged = { ...(base ?? {}), ...(override ?? {}) } as Partial<ModelCapabilities>;
  if (merged.nativeTools === undefined || merged.contextWindow === undefined) return undefined;
  return {
    nativeTools: merged.nativeTools,
    parallelToolCalls: merged.parallelToolCalls ?? false,
    contextWindow: merged.contextWindow,
    supportsSystemPrompt: merged.supportsSystemPrompt ?? true,
    promptCaching: merged.promptCaching ?? 'none',
    thinking: merged.thinking,
    sampling: merged.sampling,
  };
}
