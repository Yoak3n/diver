// Diver companion — opencode-go 模型提供商适配器。
//
// 通过 DSH 框架的 provider 插件机制（ctx.llm.registerAdapter）注册
// 'opencode-go' 路由，接入 https://opencode.ai/zen/go/v1 网关。
//
// 端点选择（按模型表）：
//   /v1/chat/completions  — glm*/kimi*/deepseek-v4*/mimo*/hy3（OpenAI 兼容，全功能含工具）
//   /v1/responses         — grok-4.5 / gpt-5.6-luna（Responses API，第一版文本流）
//   /v1/messages          — minimax-m*/qwen3.*-*（Anthropic Messages API，第一版文本流）
//
// 鉴权：可选 OPENCODE_API_KEY（凭据库 > 环境变量）；无 key 时裸请求
// （/v1/models 已验证无需鉴权）。

import { EventSourceParserStream } from 'eventsource-parser/stream'
import type { Context } from '@deepseek-ai/cordis'
import {
  attributionHeaders,
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { registerProviderConfig } from '../settings-registry.ts'
import { readDiverSettings } from '../session.ts'

export const name = 'diver-llm-opencode'

export const inject = ['llm', 'credentials']

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'
const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY'
const MODELS_CACHE_MS = 5 * 60 * 1000

/** 模型 → 端点分组（用户提供的 opencode-go 模型表） */
const RESPONSES_MODELS = new Set(['grok-4.5', 'gpt-5.6-luna'])
const ANTHROPIC_MODELS = new Set([
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
])

/**
 * 模型上下文窗口声明（compaction-basic 依赖它计算压缩阈值/保留预算）。
 * deepseek-v4 系列（deepseek-v4 / deepseek-v4-flash）窗口为 1M token；
 * 其他模型统一按 1M 保守声明（网关未披露则从宽，压缩偏晚但不影响正确性）。
 */
const MODEL_CONTEXT_WINDOW = 1024 * 1024

function endpointFor(model) {
  if (RESPONSES_MODELS.has(model)) return 'responses'
  if (ANTHROPIC_MODELS.has(model)) return 'anthropic'
  return 'chat'
}

/** 消息文本块拼接。 */
function flattenText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
}

/** 序列化消息为 OpenAI chat/completions wire 格式（照 deepseek 适配器模式）。 */
function serializeChatMessages(messages) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      const toolCalls = message.content
        .filter((b) => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
      wire.push({
        role: 'assistant',
        content: text, // 纯工具回合发送 ""（网关要求 content 或 tool_calls 至少其一）
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    // user 角色：tool-result 块展开为独立 role:'tool' 消息
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** 序列化为 Anthropic messages wire 格式（文本流路径）。 */
function serializeAnthropicMessages(messages) {
  const wire = []
  for (const message of messages) {
    const text = flattenText(message.content)
    if (!text) continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    wire.push({ role, content: text })
  }
  return wire
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

function mapUsage(usage) {
  if (!usage) return undefined
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  }
}

class OpencodeGoAdapter extends LlmAdapter {
  baseUrl: string
  ctx: Context
  modelsCache: Array<{ provider: string; id: string; name: string }> | null
  modelsCacheAt: string | null
  modelsCacheTs: number

  constructor({ baseUrl, ctx }: { baseUrl?: string; ctx: Context }) {
    super()
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL
    this.ctx = ctx
    this.modelsCache = null
    this.modelsCacheAt = null
    this.modelsCacheTs = 0
  }

  /** 生效中的 base URL：优先用户设置（diver-settings 的 opencode-go.baseUrl），否则插件配置。 */
  resolveBaseUrl() {
    try {
      const settings = readDiverSettings()
      const override = settings['opencode-go.baseUrl']
      if (typeof override === 'string' && override.trim()) return override.trim()
    } catch { /* 忽略 */ }
    return this.baseUrl
  }

  providerInfo(provider) {
    return { id: provider, name: 'opencode-go', description: 'opencode.ai Zen Go 网关' }
  }

  /** 模型目录：GET /models（无鉴权），5 分钟缓存（按 baseUrl 区分）。 */
  async listModels(provider) {
    const baseUrl = this.resolveBaseUrl()
    if (this.modelsCache && this.modelsCacheAt === baseUrl && Date.now() - this.modelsCacheTs < MODELS_CACHE_MS) {
      return this.modelsCache
    }
    try {
      const res = await fetch(`${baseUrl}/models`)
      if (res.ok) {
        const body = await res.json() as { data?: Array<{ id: string }> }
        const models = (body.data ?? [])
          .map((m) => ({ provider, id: m.id, name: m.id }))
          .sort((a, b) => a.id.localeCompare(b.id))
        this.modelsCache = models
        this.modelsCacheAt = baseUrl
        this.modelsCacheTs = Date.now()
        return models
      }
    } catch (err) {
      console.error(`[opencode-go] listModels 失败: ${err?.message ?? err}`)
    }
    return []
  }

  /** 模型元数据：声明上下文窗口（compaction-basic 依赖；缺失时压缩无法触发）。 */
  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: MODEL_CONTEXT_WINDOW },
    }
  }

  async resolveApiKey() {
    try {
      const resolved = await this.ctx.credentials?.resolve(credentialRef(DEFAULT_API_KEY_ENV))
      if (resolved?.value) return resolved.value
    } catch { /* 忽略 */ }
    return process.env[DEFAULT_API_KEY_ENV] ?? ''
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const apiKey = await this.resolveApiKey()
    const endpoint = endpointFor(options.model)
    if (endpoint === 'chat') {
      yield* this.streamChat(options, apiKey)
    } else if (endpoint === 'responses') {
      yield* this.streamResponses(options, apiKey)
    } else {
      yield* this.streamAnthropic(options, apiKey)
    }
  }

  headers(apiKey, extra = {}) {
    return {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      ...attributionHeaders(),
      ...extra,
    }
  }

  /** OpenAI 兼容 chat/completions：全功能（流式文本/推理/工具调用）。 */
  async *streamChat(options: GenerateOptions, apiKey: string): AsyncGenerator<StreamChunk> {
    if (options.tools?.length > 0) {
      // 工具调用目前只在 chat/completions 端点支持；这里无额外校验（本端点支持）
    }
    const messages = []
    if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
    messages.push(...serializeChatMessages(options.messages))

    const body = {
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...options.tools?.length > 0
        ? { tools: options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      ...options.stop !== undefined ? { stop: options.stop } : {},
    }

    let response
    try {
      response = await fetch(`${this.resolveBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: this.headers(apiKey),
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new LlmError(`opencode-go request to ${this.resolveBaseUrl()} failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      let message = `opencode-go API error (HTTP ${response.status})`
      try {
        const parsed = await response.json()
        if (parsed?.error?.message) message = parsed.error.message
      } catch { /* 忽略 */ }
      throw new LlmError(message, response.status >= 500 ? 'TRANSPORT' : 'INVALID_REQUEST', { status: response.status })
    }
    if (!response.body) throw new LlmError('opencode-go returned no response body', 'EMPTY_RESPONSE')

    yield* translateChat(parseSse(response.body))
  }

  /** Responses API（grok/gpt）：第一版文本流，暂不支持工具。 */
  async *streamResponses(options: GenerateOptions, apiKey: string): AsyncGenerator<StreamChunk> {
    if (options.tools?.length > 0) {
      throw new LlmError('opencode-go responses 端点（grok/gpt）暂不支持工具调用，请使用 chat/completions 端点模型', 'UNSUPPORTED_CONTENT')
    }
    const body = {
      model: options.model,
      input: options.messages
        .filter((m) => flattenText(m.content))
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'input_text', text: flattenText(m.content) }] })),
      stream: true,
      ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
    }
    let response
    try {
      response = await fetch(`${this.resolveBaseUrl()}/responses`, {
        method: 'POST',
        headers: this.headers(apiKey),
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new LlmError(`opencode-go responses request failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      let message = `opencode-go responses error (HTTP ${response.status})`
      try {
        const parsed = await response.json()
        if (parsed?.error?.message) message = parsed.error.message
      } catch { /* 忽略 */ }
      throw new LlmError(message, response.status >= 500 ? 'TRANSPORT' : 'INVALID_REQUEST', { status: response.status })
    }
    if (!response.body) throw new LlmError('opencode-go returned no response body', 'EMPTY_RESPONSE')

    let text = ''
    for await (const payload of parseSse(response.body)) {
      let event
      try {
        event = JSON.parse(payload)
      } catch { continue }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta.length > 0) {
        text += event.delta
        yield { type: 'text-delta', index: 0, text: event.delta }
      } else if (event.type === 'response.completed') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      } else if (event.type === 'error') {
        throw new LlmError(event.error?.message ?? 'opencode-go responses error', 'TRANSPORT')
      }
    }
    yield {
      type: 'finish',
      reason: text.length === 0
        ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
        : { kind: 'stop' },
    }
  }

  /** Anthropic Messages API（minimax/qwen）：第一版文本流，暂不支持工具。 */
  async *streamAnthropic(options: GenerateOptions, apiKey: string): AsyncGenerator<StreamChunk> {
    if (options.tools?.length > 0) {
      throw new LlmError('opencode-go messages 端点（minimax/qwen）暂不支持工具调用，请使用 chat/completions 端点模型', 'UNSUPPORTED_CONTENT')
    }
    const body = {
      model: options.model,
      ...options.system !== undefined ? { system: options.system } : {},
      messages: serializeAnthropicMessages(options.messages),
      stream: true,
      max_tokens: options.maxTokens ?? 2048,
    }
    let response
    try {
      response = await fetch(`${this.resolveBaseUrl()}/messages`, {
        method: 'POST',
        headers: this.headers(apiKey, { 'anthropic-version': '2023-06-01' }),
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new LlmError(`opencode-go messages request failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      let message = `opencode-go messages error (HTTP ${response.status})`
      try {
        const parsed = await response.json()
        if (parsed?.error?.message) message = parsed.error.message
      } catch { /* 忽略 */ }
      throw new LlmError(message, response.status >= 500 ? 'TRANSPORT' : 'INVALID_REQUEST', { status: response.status })
    }
    if (!response.body) throw new LlmError('opencode-go returned no response body', 'EMPTY_RESPONSE')

    let text = ''
    for await (const payload of parseSse(response.body)) {
      let event
      try {
        event = JSON.parse(payload)
      } catch { continue }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        text += event.delta.text
        yield { type: 'text-delta', index: 0, text: event.delta.text }
      } else if (event.type === 'message_delta' && event.usage) {
        const usage = mapUsage({ prompt_tokens: event.usage.input_tokens, completion_tokens: event.usage.output_tokens })
        if (usage) yield { type: 'usage', usage }
      } else if (event.type === 'message_stop') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      } else if (event.type === 'error') {
        throw new LlmError(event.error?.message ?? 'opencode-go messages error', 'TRANSPORT')
      }
    }
    yield {
      type: 'finish',
      reason: text.length === 0
        ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
        : { kind: 'stop' },
    }
  }
}

/** SSE 解析（eventsource-parser；[DONE] 终哨，缺哨抛错）。 */
async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const events = stream
    // TextDecoderStream.writable 类型为 WritableStream<BufferSource>，与
    // pipeThrough 要求的 WritableStream<Uint8Array> 不兼容（TS 5.7+ 泛型化后），
    // 运行时它就是 TransformStream<Uint8Array, string>，这里显式断言。
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .pipeThrough(new EventSourceParserStream())
  for await (const { data } of events) {
    yield data
    if (data === '[DONE]') return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

/** chat/completions SSE → StreamChunk（照 deepseek translate 模式：块按 index 组装）。 */
type PendingBlock = {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

async function* translateChat(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: PendingBlock | undefined
  let reasoningBlock: PendingBlock | undefined
  const toolBlocks = new Map<number, PendingBlock>()
  const order: PendingBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  const open = (kind: PendingBlock['kind']): PendingBlock => {
    const block: PendingBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) {
        yield {
          type: 'block-end',
          index: block.index,
          block: block.kind === 'tool-call'
            ? { type: 'tool-call', id: CallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text }
            : block.kind === 'reasoning'
              ? { type: 'reasoning', text: block.text }
              : { type: 'text', text: block.text },
        }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      }
      return
    }

    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      const reasoning = delta.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

export function apply(ctx: Context, config: { baseUrl?: string }) {
  const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL
  const handle = ctx.llm.registerAdapter(['opencode-go'], new OpencodeGoAdapter({ baseUrl, ctx }))

  // 一切皆插件：本插件声明自己的配置 schema，设置面板据此动态渲染。
  registerProviderConfig({
    provider: 'opencode-go',
    name: 'opencode-go（Zen Go 网关）',
    description: 'opencode.ai Zen Go 网关：glm/kimi/deepseek-v4 等（chat/completions 全功能），grok/gpt（responses）、minimax/qwen（messages）文本流。',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        secret: true,
        store: 'credentials',
        credentialRef: DEFAULT_API_KEY_ENV,
        required: false,
        placeholder: '可选：未配置也可使用（网关无需鉴权）',
        hint: '存于凭据库（OPENCODE_API_KEY），环境变量兜底',
      },

    ],
  })

  console.log(`[opencode-go] provider 已注册 (${baseUrl})`)
  ctx.on('dispose', () => {
    // 注册句柄本身是可调用函数：调用即释放全部路由
    handle()
  })
}
