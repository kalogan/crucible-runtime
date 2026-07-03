// The Ollama adapter: POST /api/chat, non-streaming (V0.1_SPEC.md §5.3).

import type { Clock, IdGen, Rng } from '../../core/inject.js';
import { ProviderError } from '../../core/errors.js';
import type { ChatRequest, ChatResponse, ModelCapabilities, Provider } from '../types.js';
import { withRetry, DEFAULT_RETRY, type RetryPolicy } from '../retry.js';
import { lookupCapabilities } from './models.js';
import { fromWireResponse, toWireMessages, toWireTools, type OllamaChatResponse } from './translate.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  clock: Clock;
  ids: IdGen;
  rng: Rng;
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>> | undefined;
  retryPolicy?: RetryPolicy | undefined;
  onRetry?: ((attempt: number, delayMs: number, reason: string) => void) | undefined;
  fetchFn?: typeof fetch | undefined;
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  private readonly opts: OllamaProviderOptions;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OllamaProviderOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  capabilities(model: string): ModelCapabilities {
    const caps = lookupCapabilities(model, this.opts.capabilityOverrides);
    if (caps === undefined) {
      throw new ProviderError({
        kind: 'fatal',
        message:
          `no capability entry for Ollama model "${model}" — add it to the capability table ` +
          `(or config overrides) with nativeTools and an explicit contextWindow. ` +
          `Running with Ollama's silent default context would truncate agent sessions.`,
      });
    }
    if (!caps.nativeTools) {
      throw new ProviderError({
        kind: 'fatal',
        message: `model "${model}" does not support native tool calling and cannot run in this runtime.`,
      });
    }
    return caps;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const caps = this.capabilities(req.model); // fail loud before any network call
    const body = {
      model: req.model,
      messages: toWireMessages(req.messages),
      tools: toWireTools(req.tools),
      stream: false as const,
      ...(caps.thinking === true ? { think: true } : {}),
      options: {
        num_ctx: caps.contextWindow,
        ...(req.options.temperature !== undefined ? { temperature: req.options.temperature } : {}),
        ...(req.options.topP !== undefined ? { top_p: req.options.topP } : {}),
        ...(req.options.topK !== undefined ? { top_k: req.options.topK } : {}),
        ...(req.options.seed !== undefined ? { seed: req.options.seed } : {}),
        ...(req.options.maxTokens !== undefined ? { num_predict: req.options.maxTokens } : {}),
      },
    };

    const wire = await withRetry(
      () => this.post('/api/chat', body, req.options.signal),
      {
        clock: this.opts.clock,
        rng: this.opts.rng,
        signal: req.options.signal,
        onRetry: this.opts.onRetry,
      },
      this.opts.retryPolicy ?? DEFAULT_RETRY,
    );
    return fromWireResponse(wire as OllamaChatResponse, this.opts.ids);
  }

  /** Model digest from /api/tags, for the benchmark environment record. */
  async modelDigest(model: string): Promise<string | null> {
    try {
      const res = await this.fetchFn(new URL('/api/tags', this.opts.baseUrl));
      if (!res.ok) return null;
      const body = (await res.json()) as { models?: Array<{ name?: string; digest?: string }> };
      return body.models?.find((m) => m.name === model)?.digest ?? null;
    } catch {
      return null;
    }
  }

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(new URL(path, this.opts.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        throw new ProviderError({ kind: 'aborted', message: 'request aborted', cause: err });
      }
      throw new ProviderError({
        kind: 'retryable',
        message: `Ollama unreachable at ${this.opts.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryAfter = res.headers.get('retry-after');
      throw new ProviderError({
        kind: res.status === 429 || res.status >= 500 ? 'retryable' : 'fatal',
        message: `Ollama ${res.status}: ${text.slice(0, 500)}`,
        status: res.status,
        ...(retryAfter !== null && Number.isFinite(Number(retryAfter))
          ? { retryAfterMs: Number(retryAfter) * 1_000 }
          : {}),
      });
    }
    return res.json();
  }
}
