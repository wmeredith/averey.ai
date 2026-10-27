export {
  Averey,
  type AvereyOptions,
  type RunInput,
  type RunResult,
  type Status,
  type Trace,
  type TraceModifier,
} from "./averey.js";
export {
  AvereyTeam,
  decideBias,
  type BiasAuditEntry,
  type BiasGroupReport,
  type Labels,
} from "./team.js";
export {
  DEFAULT_CONFIG,
  resolveConfig,
  type AvereyConfig,
  type BiasWeight,
  type DeepPartial,
} from "./config.js";
export { type Clock, SystemClock, VirtualClock } from "./core/clock.js";
export { Rng, rngFor } from "./core/rng.js";
export {
  Schedule,
  type Availability,
  type AwayReason,
  type Block,
  type DayPlan,
} from "./core/schedule.js";
export {
  FileStateStore,
  InMemoryStore,
  type StateStore,
  type WorkerState,
} from "./core/state.js";
export { computeLevers, type Levers } from "./levers.js";
export { LossyMemory, type RecallResult } from "./memory.js";
export { computeModifiers, MODIFIERS, type Modifier } from "./modifiers.js";
export { findHardWords, isHardWord } from "./persona/comprehension.js";
export { buildSystemPrompt, injectTypos } from "./persona/prompt.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { MockProvider } from "./providers/mock.js";
export type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from "./providers/types.js";
export {
  HeuristicSincerityScorer,
  LLMSincerityScorer,
  type SincerityScorer,
} from "./sincerity.js";
