// Public library surface (v0.1).

export type { Clock, IdGen, Rng } from './core/inject.js';
export type {
  RuntimeMessage,
  AssistantMessage,
  ToolCall,
  TokenUsage,
  JsonSchemaTool,
} from './core/messages.js';
export type { RuntimeEvent, EventSink, ToolErrorKind } from './core/events.js';
export { CrucibleError, ProviderError } from './core/errors.js';
export { runTurn } from './core/loop.js';
export type { TurnResult, TurnOutcome, Budgets, ToolExecutor } from './core/loop.js';
export { AgentSession } from './core/session.js';
export type { SessionConfig, SessionState } from './core/session.js';

export type {
  Provider,
  ChatRequest,
  ChatResponse,
  ChatOptions,
  ModelCapabilities,
} from './providers/types.js';
export { withRetry, DEFAULT_RETRY } from './providers/retry.js';
export { OllamaProvider } from './providers/ollama/provider.js';
export { OLLAMA_MODELS } from './providers/ollama/models.js';

export type { Tool, ToolContext, ToolResult, ToolSafety } from './tools/types.js';
export { ToolRegistry } from './tools/registry.js';
export { standardRegistry } from './tools/builtin/index.js';

export {
  createTranscriptWriter,
  readJournal,
  reconstructSession,
  stableStringify,
} from './host/transcript.js';
export { loadConfig } from './host/config.js';
export { realClock, realIdGen, realRng } from './host/env.js';

export { runBenchmark } from './bench/harness.js';
export { benchmarkSpecSchema, runResultSchema, benchmarkReportSchema } from './bench/spec.js';
export type { BenchmarkSpec, RunResult, BenchmarkReport, RunMetrics } from './bench/spec.js';
