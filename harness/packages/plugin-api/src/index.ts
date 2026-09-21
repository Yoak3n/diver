/**
 * @cos/plugin-api — third-party plugin type surface for Diver / cos.
 *
 * Plugins import types (and Cordis Context service-key augmentations) from
 * here so their tsconfigs need not `include` the harness tree. Internal
 * re-exports use **relative** paths into sibling `@cos/*` sources so this
 * package typechecks whether it is loaded via `node_modules` link or
 * `paths` mapping.
 *
 * Runtime service implementations are still mounted by `@cos/boot` via
 * `pluginPaths` (`@cos/llm`, `@cos/tools`, …); this package is **not** a
 * cordis plugin row.
 * @module @cos/plugin-api
 */

// Core service packages — load for Context declaration merging (ctx.* keys).
// Paths are relative to this file: packages/plugin-api/src/ → packages/<pkg>/src/
import '../../agent-loop/src/index.ts'
import '../../agents/src/index.ts'
import '../../credentials/src/index.ts'
import '../../llm/src/index.ts'
import '../../persistence/src/index.ts'
import '../../session/src/index.ts'
import '../../subagents/src/index.ts'
import '../../system-prompt/src/index.ts'
import '../../tools/src/index.ts'

// Shared vocabulary + runtime helpers plugins commonly need.
export {
  CallId,
  LlmError,
  SessionId,
  createUserMessage,
} from '../../types/src/index.ts'
export type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentStatus,
  AssembleContext,
  AssistantMessage,
  FinishReason,
  GenerateOptions,
  LlmCallConfig,
  MessageContent,
  ModelBlock,
  ModelMessage,
  PromptAssembly,
  PromptSection,
  Session,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  StreamChunk,
  TokenUsage,
  ToolSchema,
  TurnEndReason,
  UserMessage,
  WireTool,
} from '../../types/src/index.ts'

// LLM adapter surface (types + the adapter base class plugins extend).
export { LlmAdapter } from '../../llm/src/index.ts'
export type {
  AdapterConfigField,
  LlmProviderInfo,
  ProviderConfigDecl,
  ResolvedModelInfo,
} from '../../llm/src/index.ts'

// Tools registry types.
export type { ToolExecutor, ToolOptions, ToolResult } from '../../tools/src/index.ts'
