// AgentSession: one agent instance, one message log (V0.1_SPEC.md §4).

import type { Clock, IdGen } from './inject.js';
import type { EventSink } from './events.js';
import { createEmitter } from './events.js';
import type { RuntimeMessage } from './messages.js';
import type { Budgets, ToolExecutor, TurnResult } from './loop.js';
import { runTurn } from './loop.js';
import type { ChatOptions, Provider } from '../providers/types.js';
import type { SessionRef, ToolContext } from '../tools/types.js';

export interface SessionConfig {
  role: string;
  systemPrompt: string;
  provider: Provider;
  model: string;
  /** The model's context window (tokens) — feeds the loop's overflow guard. */
  contextWindow: number;
  chatOptions: Omit<ChatOptions, 'signal'>;
  tools: ToolExecutor;
  workspace: string;
  surface?: string[] | undefined;
  /** Whether a Director can approve confirm-class tools (v0.3+); default false. */
  attended?: boolean | undefined;
  budgets: Budgets;
  clock: Clock;
  ids: IdGen;
  sink: EventSink;
}

export interface SessionState {
  messages: RuntimeMessage[];
  lastTurn: TurnResult | null;
}

export class AgentSession {
  readonly id: string;
  private readonly config: SessionConfig;
  private readonly messages: RuntimeMessage[];
  private readonly abort = new AbortController();
  private lastTurn: TurnResult | null = null;

  private constructor(id: string, config: SessionConfig) {
    this.id = id;
    this.config = config;
    this.messages = [{ role: 'system', content: config.systemPrompt }];
  }

  static create(config: SessionConfig): AgentSession {
    return new AgentSession(config.ids.next('ses'), config);
  }

  async runTurn(input: string): Promise<TurnResult> {
    const { config } = this;
    this.messages.push({ role: 'user', content: input });

    const emitter = createEmitter(this.id, () => config.clock.now(), config.sink);
    const session: SessionRef = { id: this.id, role: config.role };
    const toolContext: ToolContext = {
      workspace: config.workspace,
      surface: config.surface,
      attended: config.attended ?? false,
      signal: this.abort.signal,
      clock: config.clock,
      emitter,
      session,
    };

    this.lastTurn = await runTurn({
      provider: config.provider,
      model: config.model,
      contextWindow: config.contextWindow,
      chatOptions: config.chatOptions,
      messages: this.messages,
      tools: config.tools,
      toolContext,
      budgets: config.budgets,
      signal: this.abort.signal,
      emitter,
      clock: config.clock,
    });
    return this.lastTurn;
  }

  cancel(): void {
    this.abort.abort();
  }

  /** Final state for replay validation: deep-compared against the journal reconstruction. */
  state(): SessionState {
    return { messages: structuredClone(this.messages), lastTurn: structuredClone(this.lastTurn) };
  }
}
